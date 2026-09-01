import type { ProjectContext } from "./schema";

export function selectComponents(context: ProjectContext, text: string): ProjectContext["components"] {
  const tokens = words(text);
  const ranked = context.components.map((component) => ({ component, score: score(component, tokens) })).sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0]!.score < 2 || (ranked[1] && ranked[0]!.score - ranked[1].score < 1)) return context.components;
  return ranked.slice(0, 3).map(({ component }) => component);
}

function score(component: ProjectContext["components"][number], tokens: Set<string>): number {
  return [component.id, component.description, ...component.aliases, ...component.indicators]
    .reduce((total, value) => total + [...words(value)].filter((token) => tokens.has(token)).length, 0);
}
function words(value: string): Set<string> { return new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []); }
