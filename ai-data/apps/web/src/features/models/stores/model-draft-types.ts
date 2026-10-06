/** 凭据按每个版本完整录入；表单不会从公开详情补出旧秘密。 */
type ModelDraft = {
  model_id: string;
  version: number;
  name: string;
  base_url: string;
  model: string;
  context_window?: number;
  authentication: "none" | "key" | "headers" | "both";
  api_key: string;
  headers: { name: string; value: string }[];
  authentication_confirmed: boolean;
};
export type { ModelDraft };
