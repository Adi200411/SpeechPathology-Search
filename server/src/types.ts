export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export type Resource = {
  id?: string;
  _id?: string;
  title: string;
  description: string;
  url?: string;
  fileId?: string;
  tags: string[];
  ageRange?: string;
  type?: string;
  folder?: string;
  uploadedBy?: string;
  createdAt: string;
  extractedText?: string;
  insight?: string;
};
