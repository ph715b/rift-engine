/** Standard client-side "download this text as a file" dance — a Blob +
 *  object URL + a synthetic anchor click, no extra dependency needed. */
export function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
