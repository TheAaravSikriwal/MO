/**
 * Show place names in English where the map has them, in the local name
 * otherwise. Only labels that show a name: road shields show a road's number
 * and house labels its number, and rewriting those would blank them.
 */
export function namesInEnglish(field: unknown): unknown | null {
  const text = JSON.stringify(field ?? null)
  const showsName = /"name(:[a-z_]+)?"|"name_[a-z]+"|\{name(:[a-z_]+)?\}/.test(text)
  const showsOther = /"ref"|"housenumber"|\{ref\}|\{housenumber\}/.test(text)
  if (!showsName || showsOther) return null
  return ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']]
}
