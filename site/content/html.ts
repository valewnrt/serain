const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Every text that goes into the HTML of serain.si, ours and the community's. */
export const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
