export function greeting(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "Hello" : `Hello, ${trimmed}`;
}
