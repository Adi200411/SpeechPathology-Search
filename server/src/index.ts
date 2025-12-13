import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import multer from "multer";
import path from "path";
import { OpenAI } from "openai";
import { ObjectId } from "mongodb";
import { PassThrough } from "stream";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { getResourcesCollection, getUploadsBucket, getPatientsCollection } from "./db";
import { ChatMessage, Resource, Patient } from "./types";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 5000;

const loadUsers = () => {
  // Preferred: BASIC_USERS='[{"username":"name","password":"pass","email":"optional"}]'
  if (process.env.BASIC_USERS) {
    try {
      const parsed = JSON.parse(process.env.BASIC_USERS);
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .map((u) => ({
            username: u.username,
            password: u.password,
            email: u.email || "",
          }))
          .filter((u) => u.username && u.password);
        if (cleaned.length > 0) return cleaned;
      }
    } catch (err) {
      console.error("Failed to parse BASIC_USERS JSON", err);
    }
  }

  // Fallback: any BASIC_USER_* / BASIC_PASS_* pairs in env
  const envUsers: { username: string; password: string; email?: string }[] = [];
  Object.entries(process.env).forEach(([key, value]) => {
    const match = key.match(/^BASIC_USER_(.+)$/);
    if (match && value) {
      const suffix = match[1];
      const pass = process.env[`BASIC_PASS_${suffix}`];
      if (pass) {
        envUsers.push({
          username: value,
          password: pass,
          email: process.env[`BASIC_EMAIL_${suffix}`] || "",
        });
      }
    }
  });
  if (envUsers.length > 0) return envUsers;

  // Defaults
  return [
    { username: process.env.BASIC_USER_1 || "therapist", password: process.env.BASIC_PASS_1 || "speech123", email: process.env.BASIC_EMAIL_1 || "therapist@example.com" },
    { username: process.env.BASIC_USER_2 || "assistant", password: process.env.BASIC_PASS_2 || "helper123", email: process.env.BASIC_EMAIL_2 || "assistant@example.com" },
  ];
};

const USERS = loadUsers();

const tokenize = (input: string): string[] =>
  input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const stem = (token: string): string => {
  if (token.length <= 3) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("es")) return token.slice(0, -2);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
};

type AuthedRequest = Request & { user?: { sub: string; email?: string; name?: string } };

const verifyAuth = (req: AuthedRequest, res: Response, next: () => void) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) {
    return res.status(401).json({ error: "Missing auth" });
  }
  const token = header.replace("Basic ", "").trim();
  const decoded = Buffer.from(token, "base64").toString("utf8");
  const [username, password] = decoded.split(":");
  const user = USERS.find((u) => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  req.user = { sub: user.username, email: user.email, name: user.username };
  next();
};

const deriveLetterTags = (text: string): string[] => {
  const letters = text.match(/[a-z]/gi) || [];
  const unique = Array.from(new Set(letters.map((l) => l.toLowerCase())));
  return unique.flatMap((l) => [l, `/${l}/`, `letter-${l}`]);
};

const toResource = (doc: any): Resource => ({
  id: doc._id?.toString(),
  _id: doc._id?.toString(),
  title: doc.title,
  description: doc.description,
  url: doc.url,
  fileId: doc.fileId,
  tags: doc.tags || [],
  ageRange: doc.ageRange,
  type: doc.type,
  uploadedBy: doc.uploadedBy,
  createdAt: doc.createdAt,
  extractedText: doc.extractedText,
  insight: doc.insight,
  ownerId: doc.ownerId,
  ownerEmail: doc.ownerEmail,
  patientIds: doc.patientIds || [],
});

const toPatient = (doc: any): Patient => ({
  id: doc._id?.toString(),
  _id: doc._id?.toString(),
  name: doc.name,
  notes: doc.notes,
  ownerId: doc.ownerId,
  ownerEmail: doc.ownerEmail,
  createdAt: doc.createdAt,
});

const scoreResources = (query: string, list: Resource[]): Resource[] => {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const scored = list
    .map((resource) => {
      const letterTags = deriveLetterTags(resource.title);
      const corpus = `${resource.title} ${resource.description} ${(resource.tags || []).join(" ")} ${letterTags.join(" ")} ${resource.extractedText ?? ""}`;
      const rTokens = tokenize(corpus);
      const tokenSet = new Set(rTokens);
      const stemSet = new Set(rTokens.map(stem));

      const overlap = qTokens.reduce((acc, tok) => (tokenSet.has(tok) ? acc + 2 : acc), 0);
      const stemOverlap = qTokens.reduce((acc, tok) => (stemSet.has(stem(tok)) ? acc + 1 : acc), 0);

      const substrBonus = qTokens.reduce((acc, tok) => {
        const hit = (resource.tags || []).some((t) => t.toLowerCase().includes(tok));
        return hit ? acc + 1 : acc;
      }, 0);

      const includesFull = corpus.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
      const score = overlap + stemOverlap + substrBonus + includesFull;
      return { resource, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((item) => item.resource).slice(0, 5);
};

const safeJsonParse = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const pdfParser = pdfParse as unknown as (data: Buffer) => Promise<{ text?: string }>;

const extractTextFromFile = async (mimetype: string, buffer: Buffer): Promise<string> => {
  if (mimetype?.includes("pdf")) {
    const parsed = await pdfParser(buffer);
    return parsed.text || "";
  }
  if (mimetype?.includes("word") || mimetype?.includes("docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }
  return "";
};

const suggestFromContent = async (title: string, text: string) => {
  if (!process.env.OPENAI_API_KEY || !text.trim()) {
    return { tags: [] as string[], ageRange: undefined as string | undefined, type: undefined as string | undefined, summary: undefined as string | undefined };
  }

  const clipped = text.slice(0, 4000);
  const prompt =
    "You are a speech pathology librarian. Given a title and extracted document text, return concise metadata.\n" +
    "Respond in JSON with keys: tags (<=8 short lowercase strings), ageRange (string or null), type (one of: PDF, worksheet, drill, board, checklist, story, guide, handout, article, lesson), summary (<=30 words).\n" +
    "Do not invent details. Keep tags specific to speech/phonology/AAC when relevant.";

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: `Title: ${title}\n\nExtracted text:\n${clipped}` },
    ],
    temperature: 0.2,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = safeJsonParse<{ tags?: string[]; ageRange?: string; type?: string; summary?: string }>(raw) || {};
  return {
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean).map((t) => t.toString()) : [],
    ageRange: parsed.ageRange || undefined,
    type: parsed.type || undefined,
    summary: parsed.summary || undefined,
  };
};

const buildResourceNotes = async (userMessage: string, resources: Resource[]): Promise<string[]> => {
  if (resources.length === 0) return [];

  const resourceBrief = resources
    .map(
      (r, idx) =>
        `${idx + 1}. Title: ${r.title}\nDescription: ${r.description}\nType: ${r.type ?? "resource"}\nTags: ${(r.tags || []).join(", ") || "none"}`,
    )
    .join("\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a speech pathology assistant. Write one crisp, action-focused sentence per resource (no more than 28 words). " +
        "Explain how/when to use it for the clinician. Do not invent links.",
    },
    {
      role: "user",
      content:
        `User question: ${userMessage}\n\nResources:\n${resourceBrief}\n\n` +
        "Return notes as numbered lines like `1) note...` matching the resource order. No extra text.",
    },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.4,
  });

  const text = completion.choices[0]?.message?.content ?? "";
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\)\s*/, "").trim())
    .filter(Boolean);

  return resources.map((_, idx) => lines[idx] || "");
};

app.get("/health", (_req, res) => {
  res.json({ ok: true, message: "Server healthy" });
});

// Authenticated routes
app.use("/api", verifyAuth as any);

// Patients CRUD (minimal)
app.get("/api/patients", async (req: AuthedRequest, res) => {
  try {
    const col = await getPatientsCollection();
    const docs = await col.find({ ownerId: req.user?.sub }).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ data: docs.map(toPatient) });
  } catch (err) {
    console.error("Failed to fetch patients", err);
    res.status(500).json({ error: "Failed to fetch patients" });
  }
});

app.post("/api/patients", async (req: AuthedRequest, res) => {
  const { name, notes } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Name is required" });
  }
  const newDoc: Patient = {
    name: name.trim(),
    notes: typeof notes === "string" ? notes.trim() : undefined,
    ownerId: req.user?.sub,
    ownerEmail: req.user?.email,
    createdAt: new Date().toISOString(),
  };
  try {
    const col = await getPatientsCollection();
    const result = await col.insertOne(newDoc);
    res.status(201).json({ data: { ...newDoc, id: result.insertedId.toString(), _id: result.insertedId.toString() } });
  } catch (err) {
    console.error("Failed to create patient", err);
    res.status(500).json({ error: "Failed to create patient" });
  }
});

app.delete("/api/patients/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid patient id" });
  }
  try {
    const col = await getPatientsCollection();
    const existing = await col.findOne({ _id: new ObjectId(id) as any, ownerId: req.user?.sub });
    if (!existing) {
      return res.status(404).json({ error: "Patient not found" });
    }
    await col.deleteOne({ _id: new ObjectId(id) as any });

    // Remove patient from resources
    const rCol = await getResourcesCollection();
    await rCol.updateMany({ ownerId: req.user?.sub }, { $pull: { patientIds: id } });

    res.status(204).send();
  } catch (err) {
    console.error("Failed to delete patient", err);
    res.status(500).json({ error: "Failed to delete patient" });
  }
});

// Fetch all resources (MongoDB)
app.get("/api/resources", async (req: AuthedRequest, res) => {
  try {
    const col = await getResourcesCollection();
    const docs = await col.find({ ownerId: req.user?.sub }).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ data: docs.map(toResource) });
  } catch (err) {
    console.error("Failed to fetch resources", err);
    res.status(500).json({ error: "Failed to fetch resources" });
  }
});

// Create resource
app.post("/api/upload", async (req: AuthedRequest, res: Response) => {
  const { title, description, url, tags = [], ageRange, type, uploadedBy, fileId } = req.body;

  if (!title || !description) {
    return res.status(400).json({ error: "Title and description are required." });
  }

  const providedTags = Array.isArray(tags) ? tags : [];
  const derivedTags =
    providedTags.length > 0
      ? providedTags
      : tokenize(title).filter((tok) => tok.length > 0 && tok.length <= 10);

  const letterTags = deriveLetterTags(title);

  const newDoc: Resource = {
    title,
    description,
    url,
    fileId,
    tags: Array.from(new Set([...(Array.isArray(derivedTags) ? derivedTags : []), ...letterTags])),
    ageRange,
    type,
    uploadedBy: uploadedBy || req.user?.email,
    createdAt: new Date().toISOString(),
    ownerId: req.user?.sub,
    ownerEmail: req.user?.email,
    patientIds: [],
  };

  try {
    const col = await getResourcesCollection();
    const result = await col.insertOne(newDoc);
    return res.status(201).json({ data: { ...newDoc, id: result.insertedId.toString(), _id: result.insertedId.toString() } });
  } catch (err) {
    console.error("Failed to save resource", err);
    return res.status(500).json({ error: "Failed to save resource" });
  }
});

// Update existing resource
app.put("/api/resources/:id", async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;
  const { title, description, url, tags, ageRange, type, uploadedBy, fileId, patientIds } = req.body;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid resource id" });
  }

  const toTags = () => {
    if (Array.isArray(tags)) return tags;
    if (typeof tags === "string") {
      return tags
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean);
    }
    return [];
  };

  try {
    const col = await getResourcesCollection();
    const existing = await col.findOne({ _id: new ObjectId(id) as any, ownerId: req.user?.sub });
    if (!existing) {
      return res.status(404).json({ error: "Resource not found" });
    }

    const mergedTags =
      toTags().length > 0 ? toTags() : (existing.tags as string[]) || [];
    const letterTags = deriveLetterTags(title || existing.title);

    const updateDoc: Partial<Resource> = {
      title: title ?? existing.title,
      description: description ?? existing.description,
      url: url ?? existing.url,
      fileId: fileId ?? existing.fileId,
      tags: Array.from(new Set([...(mergedTags || existing.tags || []), ...letterTags])),
      ageRange: ageRange ?? existing.ageRange,
      type: type ?? existing.type,
      uploadedBy: uploadedBy ?? existing.uploadedBy ?? req.user?.email,
      patientIds: Array.isArray(patientIds) ? patientIds.filter((p: string) => typeof p === "string") : existing.patientIds || [],
    };

    await col.updateOne({ _id: new ObjectId(id) as any }, { $set: updateDoc });
    const updated = await col.findOne({ _id: new ObjectId(id) as any });
    return res.json({ data: updated ? toResource(updated) : null });
  } catch (err) {
    console.error("Failed to update resource", err);
    return res.status(500).json({ error: "Failed to update resource" });
  }
});

// Assign/unassign patients to a resource
app.put("/api/resources/:id/patients", async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;
  const { patientIds = [] } = req.body;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid resource id" });
  }
  if (!Array.isArray(patientIds)) {
    return res.status(400).json({ error: "patientIds must be an array" });
  }
  const cleanIds = patientIds.filter((p: any) => typeof p === "string");
  try {
    const col = await getResourcesCollection();
    const existing = await col.findOne({ _id: new ObjectId(id) as any, ownerId: req.user?.sub });
    if (!existing) {
      return res.status(404).json({ error: "Resource not found" });
    }
    await col.updateOne({ _id: new ObjectId(id) as any }, { $set: { patientIds: cleanIds } });
    const updated = await col.findOne({ _id: new ObjectId(id) as any });
    res.json({ data: updated ? toResource(updated) : null });
  } catch (err) {
    console.error("Failed to update resource patients", err);
    res.status(500).json({ error: "Failed to update resource patients" });
  }
});

// Delete resource (and associated file if present)
app.delete("/api/resources/:id", async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid resource id" });
  }

  try {
    const col = await getResourcesCollection();
    const existing = await col.findOne({ _id: new ObjectId(id) as any, ownerId: req.user?.sub });
    if (!existing) {
      return res.status(404).json({ error: "Resource not found" });
    }

    await col.deleteOne({ _id: new ObjectId(id) as any });

    if (existing.fileId && ObjectId.isValid(existing.fileId)) {
      try {
        const bucket = await getUploadsBucket();
        await bucket.delete(new ObjectId(existing.fileId));
      } catch (err) {
        console.error("Failed to delete file", err);
      }
    }

    return res.status(204).send();
  } catch (err) {
    console.error("Failed to delete resource", err);
    return res.status(500).json({ error: "Failed to delete resource" });
  }
});

// File metadata upload (no parsing, just returns basic info)
app.post("/api/upload-file", upload.single("file"), async (req: AuthedRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided." });
    }

    const { originalname, mimetype, buffer } = req.file;

    const bucket = await getUploadsBucket();
    const uploadStream = bucket.openUploadStream(originalname, {
      metadata: { contentType: mimetype },
    });

    await new Promise<void>((resolve, reject) => {
      const pt = new PassThrough();
      pt.end(buffer);
      pt.pipe(uploadStream)
        .on("error", reject)
        .on("finish", () => resolve());
    });

    const fileId = uploadStream.id.toString();

    let extractedText = "";
    let suggested = { tags: [] as string[], ageRange: undefined as string | undefined, type: undefined as string | undefined, summary: undefined as string | undefined };

    try {
      extractedText = await extractTextFromFile(mimetype, buffer);
      suggested = await suggestFromContent(originalname, extractedText);
    } catch (err) {
      console.error("Content extraction/suggestion failed", err);
    }

    return res.json({
      filename: originalname,
      mimetype,
      fileId,
      url: `/api/files/${fileId}`,
      type: mimetype?.includes("pdf") ? "PDF" : mimetype?.includes("word") ? "DOCX" : mimetype || "Document",
      extractedText,
      suggested,
    });
  } catch (error) {
    console.error("Upload file error", error);
    return res
      .status(500)
      .json({ error: "Failed to process file.", detail: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Download a stored file from GridFS
app.get("/api/files/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid file id" });
    }
    const col = await getResourcesCollection();
    const ownedResource = await col.findOne({ fileId: id, ownerId: req.user?.sub });
    if (!ownedResource) {
      return res.status(404).json({ error: "File not found" });
    }
    const bucket = await getUploadsBucket();
    const downloadStream = bucket.openDownloadStream(new ObjectId(id));

    downloadStream.on("file", (file) => {
      const contentType = (file.metadata && file.metadata.contentType) || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename || "download"}"`);
    });

    downloadStream.on("error", () => {
      res.status(404).json({ error: "File not found" });
    });

    downloadStream.pipe(res);
  } catch (err) {
    console.error("Download error", err);
    res.status(500).json({ error: "Failed to download file" });
  }
});

// Chat endpoint with Mongo-backed retrieval
app.post("/api/chat", async (req: AuthedRequest, res: Response) => {
  const { message, history = [] }: { message: string; history?: ChatMessage[] } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(500)
      .json({ error: "OPENAI_API_KEY missing. Add it to your environment variables." });
  }

  try {
    const col = await getResourcesCollection();
    // naive fetch; in production consider text indexes or vector search
    const docs = await col.find({ ownerId: req.user?.sub }).limit(200).toArray();
    const resources = docs.map(toResource);

    const topMatches = scoreResources(message, resources);
  const resourceContext =
    topMatches.length > 0
      ? topMatches
          .map(
            (r, idx) =>
              `${idx + 1}. ${r.title} - ${r.description} (type: ${r.type || "resource"}, tags: ${r.tags.join(", ")})`,
          )
          .join("\n")
      : "No matching resources in the library.";

    const systemPrompt =
      "You are a speech pathology resource assistant. Recommend specific resources from the provided list when relevant. " +
      "If nothing is relevant, say so and suggest what to upload or search for next. Keep answers concise, actionable, " +
      "and focused on speech pathology practice.";

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      {
        role: "user",
        content:
          `User question: ${message}\n\nRelevant resources:\n${resourceContext}\n\n` +
          "When suggesting resources, include the title; no links needed.",
      },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.3,
    });

    const aiMessage = completion.choices[0]?.message?.content ?? "I'm sorry, I couldn't generate a response.";

    let notedResources = topMatches;
    try {
      const notes = await buildResourceNotes(message, topMatches);
      notedResources = topMatches.map((r, idx) => ({ ...r, insight: notes[idx] }));
    } catch (noteErr) {
      console.error("Failed to build resource notes", noteErr);
    }

    return res.json({
      reply: aiMessage,
      resources: notedResources,
    });
  } catch (error) {
    console.error("OpenAI or retrieval error", error);
    return res.status(502).json({
      error: "Assistant temporarily unavailable.",
      detail: error instanceof Error ? error.message : "Unknown error",
      fallback: {
        reply: "Assistant unavailable. Please try again later.",
        resources: [],
      },
    });
  }
});

// Serve built client (single Render deployment)
const clientDistPath = path.join(__dirname, "..", "..", "client", "dist");
app.use(express.static(clientDistPath));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(clientDistPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
