// Turns schema validation issues into sentences a person can act on.
// Shared by the API and the format dashboard; keep it free of server imports.
type Issue = {
  code: string;
  path: PropertyKey[];
  message: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
  values?: unknown[];
};

const labels: Record<string, string> = {
  name: "Name",
  product: "What do you offer?",
  audience: "Who is it for?",
  tone: "Voice & tone",
  facts: "Verified product facts",
  prohibited: "Claims to avoid",
  destination: "Website",
  description: "Description",
  instructions: "Writing instructions",
  slideCount: "Slide count",
  toneInstructions: "Custom writing instructions",
  websiteUrl: "Website context",
  title: "Title",
  body: "Supporting copy",
  caption: "Caption",
  account: "Target account",
  plannedAt: "Planned posting time",
  notes: "Disclosure / music notes",
  topic: "Idea",
  text: "Text",
  size: "Text size",
  width: "Width",
  height: "Height",
  x: "X position",
  y: "Y position",
  fontSize: "Heading size",
  color: "Color",
  ink: "Text color",
  accent: "Accent color",
  background: "Background color",
  overlay: "Darkening",
  imageZoom: "Image zoom",
  imageX: "Image position X",
  imageY: "Image position Y",
  direction: "Content direction",
  collection: "Collection",
  rights: "Usage rights",
  slides: "Slides",
  textLayers: "Text boxes",
  additionalAssetIds: "Grid images",
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  url: "URL",
  selectedHook: "Opening hook",
  hooks: "Hooks",
};
const roles: Record<string, string> = {
  hook: "Hook",
  body: "Content",
  cta: "CTA",
};

function where(path: PropertyKey[]) {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i],
      next = path[i + 1];
    if (key === "slides" && typeof next === "number") {
      parts.push(`Slide ${next + 1}`);
      i++;
    } else if (key === "textLayers" && typeof next === "number") {
      parts.push(`text box ${next + 1}`);
      i++;
    } else if (key === "hooks" && typeof next === "number") {
      parts.push(`Hook ${next + 1}`);
      i++;
    } else if (key === "templates" && typeof next === "string") {
      parts.push(`${roles[next] ?? next} template`);
      i++;
    }
  }
  return parts.join(", ");
}

export function describeIssue(issue: Issue) {
  // Messages written in our schemas are already human; Zod's defaults are not.
  if (!/^(Invalid|Too (big|small))/.test(issue.message)) {
    const context = where(issue.path);
    return context ? `${context}: ${issue.message}` : issue.message;
  }
  const field = [...issue.path]
    .reverse()
    .find((key): key is string => typeof key === "string" && key in labels);
  const label = field ? labels[field] : "This value";
  const max = Number(issue.maximum),
    min = Number(issue.minimum);
  let sentence: string;
  if (issue.code === "too_big")
    sentence =
      issue.origin === "string"
        ? `${label} must be ${max} characters or fewer.`
        : issue.origin === "array"
          ? `${label}: use at most ${max}.`
          : `${label} must be ${max} or less.`;
  else if (issue.code === "too_small")
    sentence =
      issue.origin === "string"
        ? min <= 1
          ? `${label} is required.`
          : `${label} must be at least ${min} characters.`
        : issue.origin === "array"
          ? `${label} needs at least ${min}.`
          : `${label} must be at least ${min}.`;
  else if (issue.code === "invalid_type")
    sentence = /received undefined/.test(issue.message)
      ? `${label} is required.`
      : `${label} has an invalid value.`;
  else if (issue.code === "invalid_format")
    sentence = /color|ink|accent|background/i.test(field ?? "")
      ? `${label} must be a hex color such as #1a2b3c.`
      : `${label} has an invalid format.`;
  else if (issue.code === "invalid_value" && issue.values?.length)
    sentence = `${label} must be one of: ${issue.values.join(", ")}.`;
  else sentence = `${label}: ${issue.message}`;
  const context = where(issue.path);
  return context ? `${context}: ${sentence}` : sentence;
}

export function describeIssues(issues: Issue[]) {
  const sentences = [...new Set(issues.map(describeIssue))];
  return (
    sentences.slice(0, 3).join(" ") +
    (sentences.length > 3 ? ` (${sentences.length - 3} more)` : "")
  );
}
