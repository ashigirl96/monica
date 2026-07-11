import type { Explanation } from "./types.gen";

export async function listExplanations(): Promise<Explanation[]> {
  const res = await fetch("/api/explanations");
  if (!res.ok) throw new Error(`Failed to list explanations: ${res.status}`);
  return res.json();
}

export async function getExplanation(id: string): Promise<Explanation> {
  const res = await fetch(`/api/explanations/${id}`);
  if (!res.ok) throw new Error(`Failed to get explanation: ${res.status}`);
  return res.json();
}

export async function deleteExplanation(id: string): Promise<void> {
  const res = await fetch(`/api/explanations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete explanation: ${res.status}`);
}
