# Speech Pathology Resource Library

## Project Overview
This MERN based web app helps speech pathologists collect, search, and chat about therapy resources. Clinicians can upload PDFs or Word documents, store links, tag materials, link them to patient profiles, and use an AI assistant to surface relevant resources quickly.

![Speechie Library preview](https://github.com/user-attachments/assets/ef364b8d-ce27-4e83-bed0-8e4bb4f762cc)

## Motivation
Speech therapy teams spend time hunting for worksheets, drills, and guides. Centralising resources with fast retrieval and contextual AI responses reduces search friction and keeps therapy sessions focused on patient needs.

## Core Features
* Resource library with uploads (PDF or Word via GridFS) and links, plus auto tagging and metadata suggestions from extracted text.
* Basic authentication with per user ownership of resources and patients.
* Patient records that can be linked to resources for case organisation.
* Search that blends lexical scoring with vector similarity on OpenAI embeddings.
* AI chat assistant that recommends resources using retrieval augmented generation (RAG) over your library.

## Architecture
* **Frontend:** React and Vite, Tailwind styles, drag and drop uploads, toast notifications, and markdown rendering for chat replies.
* **Backend:** Express and TypeScript with multer for uploads, pdf-parse and mammoth for text extraction, and OpenAI for embeddings and chat completions.
* **Data:** MongoDB for resources and patients, GridFS for file storage, vector index `resource_embedding_index` on `resources.embedding` for similarity search.
* **AI and RAG:** Query text is embedded (text-embedding-3-small), MongoDB $vectorSearch retrieves top resources; lexical scoring is a fallback. The shortlist is injected into a GPT-4o-mini prompt to ground replies, then optional per resource usage notes are generated.

## Setup
1) Prerequisites: Node 18+, MongoDB with vector search (Atlas recommended), OpenAI API key.
2) Environment (`server/.env`):
   ```env
   OPENAI_API_KEY=your key
   MONGODB_URI=your mongodb uri
   MONGODB_DB=speechpath
   PORT=5000
   BASIC_USERS=[{"username":"therapist","password":"speech123","email":"therapist@example.com"}]
   ```
   You can also use `BASIC_USER_1` and `BASIC_PASS_1` pairs if you prefer.
3) Install dependencies:
   ```bash
   cd server && npm install
   cd ../client && npm install
   ```

## Running Locally
* Start the API: `cd server && npm run dev`
* Start the web app: `cd client && npm run dev` (Vite dev server)
* Production build: `npm run build` in both `server` (emits `dist/`) and `client` (emits `dist/` served by the API).

## Usage Notes
* Uploads: PDF and DOCX files are stored in GridFS; text is extracted to suggest tags, age range, and type, and stored for search grounding.
* Chat: Requests without embeddings fall back to lexical scoring; if OpenAI environment variables are missing, chat and embedding features will not work.
* Indexing: Ensure MongoDB has a vector index named `resource_embedding_index` on `embedding` for best results.

## Skills Demonstrated
* Full stack MERN development with file uploads and GridFS
* Retrieval augmented generation with OpenAI embeddings and GPT-4o-mini
* Vector plus lexical search for resource discovery
* Secure basic auth gating with per user data isolation
