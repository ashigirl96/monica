type Result<T> = { status: "ok"; data: T } | { status: "error"; error: string };

export async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const r = await result;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}
