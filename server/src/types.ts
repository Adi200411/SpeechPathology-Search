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
  ownerId?: string;
  ownerEmail?: string;
  patientIds?: string[];
};

export type Patient = {
  id?: string;
  _id?: string;
  name: string;
  notes?: string;
  ownerId?: string;
  ownerEmail?: string;
  createdAt: string;
};
