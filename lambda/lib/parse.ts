// Models sometimes wrap JSON in ```fences``` or surrounding prose, so pull the
// object out defensively instead of trusting the response to be clean JSON.
export function extractJsonObject(raw: string): Record<string, unknown> {
  let text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object found');
    text = text.slice(start, end + 1);
  }

  const obj = JSON.parse(text);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('parsed value is not an object');
  }
  return obj as Record<string, unknown>;
}
