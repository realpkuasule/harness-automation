export function keywordClassifier(prompt: string): { writeAllowed: boolean } {
  return { writeAllowed: /fix|feature|debug/u.test(prompt) };
}
