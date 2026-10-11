import { createContext } from 'react';

/**
 * A live turn that discloses its activity splits the assistant messages it
 * names: each one's non-text parts collapse together, its text parts stay
 * visible outside the collapse. The final message's answer and footer stay
 * visible too. One shared `expanded` toggles them all.
 *
 * With justification outside Activity, every assistant message of the turn is
 * named, so the model's intermediate text stays visible between the collapsed
 * tool groups. Otherwise only the final message is named (its non-text parts
 * still collapse under the turn disclosure).
 */
export const LiveActivitySplitContext = createContext<{
    messageIds: ReadonlySet<string>;
    expanded: boolean;
    animateCollapse: boolean;
} | null>(null);
