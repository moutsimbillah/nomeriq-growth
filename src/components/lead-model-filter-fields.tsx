/** Existing leads form owns submission; these fields use the shared URL filter names. */
export function LeadModelFilterFields({ params }: { params: Record<string, string | undefined> }) {
  return <>
    <select name="tier" aria-label="Lead tier" defaultValue={params.tier || ""} className="select w-auto min-w-[140px]">
      <option value="">All lead tiers</option>
      <option value="tier_1">Tier 1</option>
      <option value="other">Other signal provider</option>
      <option value="email_no_website">Email no website</option>
      <option value="category_b">Category B</option>
      <option value="unassessed">Unassessed</option>
      <option value="excluded">Excluded records</option>
    </select>
    <select name="productFit" aria-label="Product fit" defaultValue={params.productFit || ""} className="select w-auto min-w-[130px]">
      <option value="">All product fits</option>
      <option value="high">High fit</option>
      <option value="medium">Medium fit</option>
      <option value="unknown">Unknown — needs research</option>
      <option value="low">Low fit</option>
    </select>
    <input name="minPriority" type="number" min="0" max="100" step="1" aria-label="Minimum priority" placeholder="Min priority /100" defaultValue={params.minPriority || ""} className="input w-[145px]" />
    <select name="audience" aria-label="Largest verified audience" defaultValue={params.audience || ""} className="select w-auto min-w-[150px]">
      <option value="">Any audience</option>
      <option value="unknown">Audience Unknown</option>
      <option value="0">Any verified count</option>
      <option value="1000">Largest ≥ 1K</option>
      <option value="10000">Largest ≥ 10K</option>
      <option value="50000">Largest ≥ 50K</option>
      <option value="100000">Largest ≥ 100K</option>
    </select>
    <select name="sort" aria-label="Sort leads" defaultValue={params.sort || "updated"} className="select w-auto min-w-[140px]">
      <option value="priority">Priority first</option>
      <option value="updated">Recently updated</option>
    </select>
  </>;
}
