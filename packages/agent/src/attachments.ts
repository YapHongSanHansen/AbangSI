/**
 * Attachments in a Task description (Sokosumi renders uploads as markdown links:
 * `[name.png](https://…/name.png)`). They are separated from the written prompt so
 * file names/URLs never inflate the price or pollute the generation prompt, and
 * images can drive image-to-video.
 */
export interface Attachments { text: string; images: string[]; videos: string[]; documents: string[]; other: string[] }

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i;
const VIDEO = /\.(mp4|mov|webm|m4v|mkv)(\?|#|$)/i;
const DOC = /\.(pdf|docx|txt|md|markdown|csv|json)(\?|#|$)/i;

export function extractAttachments(description: string): Attachments {
  const images: string[] = [], videos: string[] = [], documents: string[] = [], other: string[] = [];
  const add = (url: string) => {
    const u = url.trim();
    if (!/^https:\/\//i.test(u)) return;
    const path = u.split(/[?#]/)[0];
    const bucket = IMAGE.test(path) ? images : VIDEO.test(path) ? videos : DOC.test(path) ? documents : other;
    if (!bucket.includes(u)) bucket.push(u);
  };
  // Markdown links / images, including names that wrap across a line break: [name\n](url)
  let text = description.replace(/!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, (_m, url: string) => { add(url); return " "; });
  // Bare URLs
  text = text.replace(/https?:\/\/[^\s)]+/g, url => { add(url); return " "; });
  text = text.replace(/\s+/g, " ").trim();
  return { text, images, videos, documents, other };
}