export interface Review {
  understood: string;
  needsClarification: boolean;
  question: string;
}

export function parseReview(text: string): Review {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    const plain = text.trim().slice(0, 500);
    return { understood: plain, needsClarification: plain.length < 12, question: plain.length < 12 ? "What would you like me to change?" : "" };
  }
  try {
    const data = JSON.parse(match[0]) as {
      understood?: unknown;
      needsClarification?: unknown;
      question?: unknown;
    };
    const understood = String(data.understood ?? "").trim().slice(0, 500);
    const needsClarification = Boolean(data.needsClarification);
    const question = String(data.question ?? "").trim().slice(0, 500);
    return {
      understood,
      needsClarification,
      question: needsClarification ? question || "What would you like me to change?" : question,
    };
  } catch {
    const plain = text.trim().slice(0, 500);
    return { understood: plain, needsClarification: false, question: "" };
  }
}

export function progressLabel(toolName: string): string | undefined {
  switch (toolName) {
    case "Read":
    case "Glob":
      return "Reading the project";
    case "Grep":
      return "Searching the project";
    case "Edit":
    case "Write":
      return "Updating the project";
    default:
      return undefined;
  }
}
