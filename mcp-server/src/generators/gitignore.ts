/**
 * Generate .gitignore entries for harness-related files.
 */

const HARNESS_ENTRIES = [
  "",
  "# Harness Automation System",
  ".harness/state.json",
  ".harness/backups/",
  "",
];

/**
 * Generate .gitignore additions for harness files.
 * Returns only the new entries that should be appended.
 */
export function generateGitignore(existingContent?: string): string {
  const existing = existingContent || "";

  const newEntries = HARNESS_ENTRIES.filter(
    (entry) => entry.trim() === "" || !existing.includes(entry.trim()),
  );

  return newEntries.join("\n");
}
