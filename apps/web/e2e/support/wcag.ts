// The axe tags every e2e accessibility run uses: all WCAG 2.0, 2.1 and 2.2 Level A and AA rules axe-core
// ships (it has no `wcag22a` tag). BL-01 6649566516: `wcag21a` (e.g. 2.5.3 Label in Name) was missing.
export const WCAG_A_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface Violation {
  readonly id: string;
  readonly nodes: readonly { readonly html: string }[];
}

/**
 * The one vendor exception, and only for the rule `wcag21a` newly brings in: Bryntum Calendar's own day
 * cells and day headers (`b-calendar-cell`, `b-day-name`) carry Bryntum's aria-labels ("Sunday 1st
 * November, No events.") around a visible day number. That DOM is the vendor's, not ours (BL-01
 * 6649566516 lists it). Every other node of that rule, and every other rule on those nodes, still fails.
 */
export function withoutVendorLabelInName<V extends Violation>(violations: readonly V[]): V[] {
  const vendor = /class="[^"]*\bb-(calendar-cell|day-name)\b/;
  return violations
    .map((v) =>
      v.id === "label-content-name-mismatch" ? { ...v, nodes: v.nodes.filter((n) => !vendor.test(n.html)) } : v,
    )
    .filter((v) => v.nodes.length > 0);
}
