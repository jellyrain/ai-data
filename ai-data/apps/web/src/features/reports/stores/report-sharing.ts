import { shallowReactive } from "vue";
import {
  reportSharingSchema,
  reportShareCandidatesSchema,
  reportSharingInputSchema,
} from "@ai-data/contracts";
import type { ReportSharing, ReportShareCandidate, ReportShareMember } from "@ai-data/contracts";
import { ApiError } from "../../../shared/http/api-error";
import type { SharingDependencies, SharingState } from "./report-sharing-types";
function initial(): SharingState {
  return {
    reportId: "",
    baseline: null,
    conflict: null,
    selected: [],
    candidates: [],
    loading: false,
    searching: false,
    saving: false,
    uncertain: false,
    saved: false,
    error: "",
  };
}
const same = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
/** 分享写入以最新头版本为基准；不确定回执只通过读取核实。 */
class ReportSharingController {
  readonly state = shallowReactive<SharingState>(initial());
  private controller = new AbortController();
  private searchController = new AbortController();
  private generation = 0;
  private searchSequence = 0;
  private unregister: () => void;
  constructor(private dependencies: SharingDependencies) {
    this.unregister = dependencies.resources.register(() => this.leave());
  }
  leave() {
    this.controller.abort();
    this.searchController.abort();
    this.generation++;
    Object.assign(this.state, initial(), { nextCursor: undefined });
  }
  dispose() {
    this.leave();
    this.unregister();
  }
  private current(generation: number) {
    return generation === this.generation && !this.controller.signal.aborted;
  }
  private path() {
    return `/api/reports/${encodeURIComponent(this.state.reportId)}`;
  }
  private fail(error: unknown) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) this.leave();
    this.state.error = error instanceof ApiError ? error.message : "分享设置读取失败，请重试";
  }
  private async read(): Promise<ReportSharing> {
    const value = reportSharingSchema.parse(
      await this.dependencies.request(`${this.path()}/sharing`, { signal: this.controller.signal }),
    );
    if (
      value.report_id !== this.state.reportId ||
      value.owner_user_id !== this.dependencies.identity()?.userId
    )
      throw new ApiError("分享设置归属不一致", 403);
    return value;
  }
  async open(reportId: string) {
    this.leave();
    this.controller = new AbortController();
    this.state.reportId = reportId;
    this.state.loading = true;
    const generation = this.generation;
    try {
      const value = await this.read();
      if (this.current(generation)) {
        this.state.baseline = value;
        this.state.selected = value.members;
      }
    } catch (error) {
      if (this.current(generation)) this.fail(error);
    } finally {
      if (this.current(generation)) this.state.loading = false;
    }
  }
  async search(search: string, more = false) {
    if (!this.state.baseline || (more && (!this.state.nextCursor || this.state.searching))) return;
    this.searchController.abort();
    this.searchController = new AbortController();
    const generation = this.generation,
      sequence = ++this.searchSequence;
    this.state.searching = true;
    this.state.error = "";
    const query = new URLSearchParams({ search: search.trim(), limit: "20" });
    if (more && this.state.nextCursor) query.set("cursor", this.state.nextCursor);
    if (!more) {
      this.state.candidates = [];
      this.state.nextCursor = undefined;
    }
    try {
      const value = reportShareCandidatesSchema.parse(
        await this.dependencies.request(`${this.path()}/share-candidates?${query}`, {
          signal: AbortSignal.any([this.controller.signal, this.searchController.signal]),
        }),
      );
      if (!this.current(generation) || sequence !== this.searchSequence) return;
      this.state.candidates = [
        ...new Map([...this.state.candidates, ...value.items].map((m) => [m.user_id, m])).values(),
      ];
      this.state.nextCursor = value.next_cursor;
    } catch (error) {
      if (this.current(generation) && sequence === this.searchSequence) this.fail(error);
    } finally {
      if (this.current(generation) && sequence === this.searchSequence)
        this.state.searching = false;
    }
  }
  toggle(member: ReportShareCandidate | ReportShareMember, selected: boolean) {
    if (this.state.saving || this.state.conflict || this.state.uncertain) return;
    this.state.saved = false;
    this.state.selected = this.state.selected.filter((m) => m.user_id !== member.user_id);
    if (selected)
      this.state.selected = [
        ...this.state.selected,
        { ...member, status: "status" in member ? member.status : "active" },
      ];
  }
  /** 仅合并相对于原基准的显式增删；远端新增成员继续保留。 */
  merge() {
    const remote = this.state.conflict,
      base = this.state.baseline;
    if (!remote || !base || this.state.saving) return;
    const selected = this.state.selected;
    const removed = base.shared_with.filter((id) => !selected.some((m) => m.user_id === id));
    const added = selected.filter((m) => !base.shared_with.includes(m.user_id));
    this.state.selected = [
      ...new Map(
        [...remote.members.filter((m) => !removed.includes(m.user_id)), ...added].map((m) => [
          m.user_id,
          m,
        ]),
      ).values(),
    ];
    this.state.baseline = remote;
    this.state.conflict = null;
    this.state.uncertain = false;
    this.state.error = "";
  }
  async reconcile(
    target = this.state.selected.map((m) => m.user_id),
    generation = this.generation,
  ) {
    this.state.uncertain = true;
    try {
      const latest = await this.read();
      if (!this.current(generation)) return;
      if (same(latest.shared_with, target)) {
        this.state.baseline = latest;
        this.state.selected = latest.members;
        this.state.conflict = null;
        this.state.uncertain = false;
        this.state.saved = true;
        this.state.error = "";
        await this.dependencies.changed();
      } else {
        this.state.conflict = latest;
        this.state.uncertain = false;
        this.state.error = "分享范围已变化，请核对后合并草稿";
      }
    } catch (error) {
      if (this.current(generation)) this.fail(error);
    }
  }
  async save() {
    const base = this.state.baseline;
    if (!base || this.state.saving || this.state.conflict || this.state.uncertain) return;
    const target = this.state.selected.map((m) => m.user_id);
    if (same(base.shared_with, target)) return;
    if (this.state.selected.some((m) => m.status !== "active")) {
      this.state.error = "请先移除停用或不可用成员";
      return;
    }
    const parsed = reportSharingInputSchema.safeParse({
      expected_version: base.expected_version,
      shared_with: target,
    });
    if (!parsed.success) {
      this.state.error = "最多可分享给 1,000 位成员";
      return;
    }
    const generation = this.generation;
    this.state.saving = true;
    this.state.error = "";
    this.state.saved = false;
    try {
      await this.dependencies.request(`${this.path()}/sharing`, {
        method: "PUT",
        body: parsed.data,
        signal: this.controller.signal,
      });
      if (this.current(generation)) await this.reconcile(target, generation);
    } catch (error) {
      if (!this.current(generation)) return;
      if (
        error instanceof ApiError &&
        error.status !== 0 &&
        error.status < 500 &&
        error.status !== 409
      )
        this.fail(error);
      else await this.reconcile(target, generation);
    } finally {
      if (this.current(generation)) this.state.saving = false;
    }
  }
}
export { ReportSharingController };
