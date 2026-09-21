import type { MetadataQueryExecutor, MetadataStatement } from "@ai-data/metadata";

const executors = new WeakMap<MetadataQueryExecutor, MetadataQueryExecutor>();
/** mssql 的事务只允许一个在途请求；目录内部并行读取仍沿同一连接按顺序执行。 */
function serialExecutor(executor: MetadataQueryExecutor): MetadataQueryExecutor {
  const existing = executors.get(executor);
  if (existing) return existing;
  let tail: Promise<unknown> = Promise.resolve();
  let failed = false;
  let failure: unknown;
  const serial: MetadataQueryExecutor = {
    execute<T extends Record<string, unknown>>(statement: MetadataStatement) {
      const task = tail.then(() => {
        if (failed) throw failure;
        return executor.execute<T>(statement).catch((error) => {
          failed = true;
          failure = error;
          throw error;
        });
      });
      tail = task.catch(() => {});
      return task;
    },
  };
  executors.set(executor, serial);
  return serial;
}

export { serialExecutor };
