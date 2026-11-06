import { ShieldAlert } from "lucide-react";

/**
 * The standard template, shown where it belongs: beside the AI actions it stands in for.
 *
 * It is used only when no AI provider answers — none assigned, or every one in the order failed —
 * and every result it produces says so, so a template is never mistaken for AI writing.
 */
export function NoAiFallbackCard() {
  return (
    <div className="mt-4 rounded-xl border border-line bg-white/50 px-3.5 py-3" data-no-ai-fallback>
      <div className="flex items-center gap-2 text-12 font-bold text-ink">
        <ShieldAlert size={13} className="text-muted" /> No-AI fallback
      </div>
      <p className="mt-1 text-12 leading-5 text-muted">
        A standard template, used only when no AI provider answers — nothing assigned, or every
        provider in the failover order failed. It still gets claim warnings and never sends on its own.
      </p>
      <ul className="mt-2 space-y-1 text-12 leading-5 text-muted">
        <li>
          Suggest with AI shows <span className="font-semibold text-ink">“Standard template — no AI provider connected”</span>{" "}
          or <span className="font-semibold text-ink">“AI provider failed — standard template”</span>.
        </li>
        <li>
          First emails and follow-ups are marked <span className="font-semibold text-ink">“No-AI fallback — standard template”</span>{" "}
          instead of “Written by …”.
        </li>
        <li>Translation and Simulate a test reply have no template: they say plainly that no provider answered.</li>
      </ul>
    </div>
  );
}
