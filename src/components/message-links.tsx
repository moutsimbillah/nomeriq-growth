import { Fragment } from "react";
import { shortenUrl, splitTextWithLinks } from "@/lib/email/message-links";

/**
 * A message body's text with its URLs drawn as links.
 *
 * A long URL is shown shortened but links to the full address, and the surrounding text is
 * rendered exactly as stored — the only change is that a 2,000-character tracking URL no longer
 * has to fit on the screen.
 */
export function TextWithLinks({ text }: { text: string }) {
  const segments = splitTextWithLinks(text);
  if (segments.length === 0) return null;
  if (segments.length === 1 && segments[0].type === "text") return <>{text}</>;

  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "link" ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noreferrer noopener"
            title={segment.href}
            className="link break-all"
          >
            {shortenUrl(segment.text)}
          </a>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}
