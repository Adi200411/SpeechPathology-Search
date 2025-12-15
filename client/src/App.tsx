import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Toaster, toast } from "react-hot-toast";
import { useDropzone } from "react-dropzone";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

type Resource = {
  id: string;
  title: string;
  description: string;
  url?: string;
  fileId?: string;
  tags: string[];
  ageRange?: string;
  type?: string;
  uploadedBy?: string;
  createdAt?: string;
  insight?: string;
  patientIds?: string[];
};

type Message = {
  role: "user" | "assistant";
  content: string;
  resources?: Resource[];
};

type ChatPayloadMessage = {
  role: "user" | "assistant";
  content: string;
};

type UploadFormState = {
  title: string;
  description: string;
  url: string;
  fileId?: string;
  tags: string[] | string;
  ageRange: string;
  type: string;
  uploadedBy: string;
};

type Folder = {
  id: string;
  name: string;
  isLocked?: boolean;
};

type Patient = {
  id: string;
  name: string;
  notes?: string;
};

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000";
const AUTH_STORAGE_KEY = "speech-basic-auth";


const initialAssistant: Message = {
  role: "assistant",
  content:
    " I can search the resource library, find relevant resources, and help you upload new materials. What do you need today?",
};

const BASE_FOLDERS: Folder[] = [
  { id: "all", name: "All resources", isLocked: true },
  { id: "unsorted", name: "Unsorted", isLocked: true },
];

const FOLDER_STORAGE_KEY = "speech-path-library-folders";
const FOLDER_MAP_STORAGE_KEY = "speech-path-library-folder-map";

const markdownComponents: Components = {
  a: ({ node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  ),
  ul: (props) => <ul className="list-disc pl-5" {...props} />,
  ol: (props) => <ol className="list-decimal pl-5" {...props} />,
};

function App() {
  const [messages, setMessages] = useState<Message[]>([initialAssistant]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [library, setLibrary] = useState<Resource[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [editResourceId, setEditResourceId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const [quickPrompts, setQuickPrompts] = useState<string[]>([
    "Need articulation drill cards for /s/ at phrase level",
    "Show AAC core boards for early communicators",
    "Language sample checklist for school-age students",
    "What materials should I prep for phonology (fronting)?",
  ]);
  const [customPrompt, setCustomPrompt] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [newPatient, setNewPatient] = useState<{ name: string; notes: string }>({ name: "", notes: "" });
  const [showPatientModal, setShowPatientModal] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<{ name?: string; email?: string } | null>(null);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });

  const initialUploadForm: UploadFormState = {
    title: "",
    description: "",
    url: "",
    fileId: "",
    tags: "",
    ageRange: "",
    type: "",
    uploadedBy: "",
  };

  const [uploadForm, setUploadForm] = useState<UploadFormState>(initialUploadForm);
  const hasFile = !!uploadForm.fileId;
  const hasLink = !!uploadForm.url?.trim() && !hasFile;

  const [folders, setFolders] = useState<Folder[]>(() => {
    if (typeof window === "undefined") return BASE_FOLDERS;
    const stored = window.localStorage.getItem(FOLDER_STORAGE_KEY);
    if (!stored) return BASE_FOLDERS;
    try {
      const parsed = JSON.parse(stored) as Folder[];
      const custom = parsed.filter((f) => !BASE_FOLDERS.some((b) => b.id === f.id));
      return [...BASE_FOLDERS, ...custom];
    } catch {
      return BASE_FOLDERS;
    }
  });

  const [resourceFolderMap, setResourceFolderMap] = useState<Record<string, string | undefined>>(() => {
    if (typeof window === "undefined") return {};
    const stored = window.localStorage.getItem(FOLDER_MAP_STORAGE_KEY);
    if (!stored) return {};
    try {
      return JSON.parse(stored) as Record<string, string | undefined>;
    } catch {
      return {};
    }
  });

  const [selectedFolderId, setSelectedFolderId] = useState<string>("all");
  const [draggingResourceId, setDraggingResourceId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState("");
  const [returnToLibraryAfterEdit, setReturnToLibraryAfterEdit] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const deleteTimers = useRef<Record<string, number | undefined>>({});
  const patientDeleteTimers = useRef<Record<string, number | undefined>>({});

  const syncResourceUpdateInChat = (updated: Resource) => {
    if (!updated.id) return;
    setMessages((prev) =>
      prev.map((msg) =>
        msg.resources
          ? { ...msg, resources: msg.resources.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)) }
          : msg,
      ),
    );
  };

  const syncResourceDeleteInChat = (id: string) => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.resources ? { ...msg, resources: msg.resources.filter((r) => r.id !== id) } : msg,
      ),
    );
  };

  const closeUploadModal = () => {
    setShowUpload(false);
    setUploadForm(initialUploadForm);
    setFileStatus(null);
    setFileLoading(false);
    if (returnToLibraryAfterEdit) {
      setShowLibrary(true);
      setReturnToLibraryAfterEdit(false);
    }
  };

  useEffect(() => {
    const fetchResources = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/resources`, {
          headers: authToken ? { Authorization: `Basic ${authToken}` } : {},
        });
        if (res.status === 401) {
          handleAuthError();
          return;
        }
        const data = await res.json();
        setLibrary(data.data || []);
      } catch (err) {
        console.error("Failed to load resources", err);
      }
    };

    if (authToken) {
      fetchResources();
    }
  }, [authToken]);

  useEffect(() => {
    const fetchPatients = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/patients`, {
          headers: authToken ? { Authorization: `Basic ${authToken}` } : {},
        });
        if (res.status === 401) {
          handleAuthError();
          return;
        }
        const data = await res.json();
        setPatients(data.data || []);
      } catch (err) {
        console.error("Failed to load patients", err);
      }
    };
    if (authToken) {
      fetchPatients();
    }
  }, [authToken]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (showUpload) {
      setTimeout(() => titleInputRef.current?.focus(), 50);
    }
  }, [showUpload]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (stored) {
      setAuthToken(stored);
      try {
        const decoded = atob(stored).split(":");
        setUserProfile({ name: decoded[0], email: "" });
      } catch {
        setUserProfile(null);
      }
    }
  }, []);

  const historyForApi = useMemo<ChatPayloadMessage[]>(
    () =>
      messages.map((message): ChatPayloadMessage => ({
        role: message.role,
        content: message.content,
      })),
    [messages],
  );

  const tagList = useMemo<string[]>(
    () =>
      Array.isArray(uploadForm.tags)
        ? uploadForm.tags
        : uploadForm.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
    [uploadForm.tags],
  );

  const patientMap = useMemo(() => {
    const map: Record<string, Patient> = {};
    patients.forEach((p) => {
      if (p.id) map[p.id] = p;
    });
    return map;
  }, [patients]);

  const formatType = (t?: string) => {
    if (!t) return undefined;
    const lower = t.toLowerCase();
    if (lower.includes("pdf")) return "PDF";
    if (lower.includes("word") || lower.includes("doc")) return "DOCX";
    return t;
  };

  const formatDate = (iso?: string) => {
    if (!iso) return "Recently updated";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Recently updated";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  const normalizeUrl = (url?: string) => {
    if (!url) return "";
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    return `${API_BASE}${url}`;
  };

  const handleView = async (resource: Resource) => {
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    const normalized = normalizeUrl(resource.url);
    if (!normalized) return;
    try {
      const res = await fetch(normalized, { headers: { Authorization: `Basic ${authToken}` } });
      if (!res.ok) throw new Error("View failed");
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      window.open(href, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error(err);
      pushNotice("View failed. Please try again.", "error");
    }
  };

  const clearAuth = () => {
    setAuthToken(null);
    setUserProfile(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  };

  const handleLogin = async () => {
    const user = loginForm.username.trim();
    const pass = loginForm.password.trim();
    if (!user || !pass) {
      pushNotice("Enter username and password", "error");
      return;
    }
    const token = btoa(`${user}:${pass}`);
    try {
      const res = await fetch(`${API_BASE}/api/auth-check`, {
        headers: { Authorization: `Basic ${token}` },
        method: "GET",
      });
      if (!res.ok) {
        throw new Error("Invalid credentials");
      }
      setAuthToken(token);
      setUserProfile({ name: user, email: "" });
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AUTH_STORAGE_KEY, token);
      }
      pushNotice("Signed in", "success");
    } catch (err) {
      console.error("Login failed", err);
      clearAuth();
      pushNotice("Invalid username or password", "error");
    }
  };

  const handleLogout = () => {
    setAuthToken(null);
    setUserProfile(null);
    setUploadForm(initialUploadForm);
    setFileStatus(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  };

  const pushNotice = (message: string, type: "success" | "info" | "error" = "success") => {
    if (type === "error") {
      toast.error(message);
      return;
    }
    if (type === "info") {
      toast(message);
      return;
    }
    toast.success(message);
  };

  const handleAuthError = () => {
    pushNotice("Session expired or invalid. Please sign in again.", "error");
    clearAuth();
    setLibrary([]);
    setPatients([]);
  };

  const handleAddPatient = async () => {
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    const name = newPatient.name.trim();
    if (!name) {
      pushNotice("Patient name is required.", "error");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/patients`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${authToken}` },
        body: JSON.stringify({ name, notes: newPatient.notes.trim() || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to add patient");
      }
      const data = await res.json();
      setPatients((prev) => [data.data, ...prev]);
      setNewPatient({ name: "", notes: "" });
      pushNotice("Patient added", "success");
    } catch (err) {
      console.error(err);
      pushNotice("Could not add patient.", "error");
    }
  };

  const handleDeletePatient = (id?: string) => {
    if (!authToken || !id) return;
    const removed = patients.find((p) => p.id === id);
    if (!removed) return;

    setPatients((prev) => prev.filter((p) => p.id !== id));
    setLibrary((prev) =>
      prev.map((r) => ({
        ...r,
        patientIds: (r.patientIds || []).filter((pid) => pid !== id),
      })),
    );
    setMessages((prev) =>
      prev.map((msg) =>
        msg.resources
          ? {
              ...msg,
              resources: msg.resources.map((r) => ({
                ...r,
                patientIds: (r.patientIds || []).filter((pid) => pid !== id),
              })),
            }
          : msg,
      ),
    );

    const undoDelete = () => {
      const t = patientDeleteTimers.current[id];
      if (t) {
        clearTimeout(t);
        delete patientDeleteTimers.current[id];
      }
      setPatients((prev) => [removed, ...prev]);
      setLibrary((prev) =>
        prev.map((r) => ({
          ...r,
          patientIds: r.patientIds ? [...r.patientIds, id] : [id],
        })),
      );
      setMessages((prev) =>
        prev.map((msg) =>
          msg.resources
            ? {
                ...msg,
                resources: msg.resources.map((r) => ({
                  ...r,
                  patientIds: r.patientIds ? [...r.patientIds, id] : [id],
                })),
              }
            : msg,
        ),
      );
      pushNotice("Patient restored", "info");
    };

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/patients/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Basic ${authToken}` },
        });
        if (!res.ok && res.status !== 204) {
          throw new Error("Failed to delete patient");
        }
      } catch (err) {
        console.error(err);
        undoDelete();
      } finally {
        delete patientDeleteTimers.current[id];
      }
    }, 5000);

    patientDeleteTimers.current[id] = timer;

    toast.custom(
      () => (
        <div className="rounded-2xl border bg-white px-4 py-3 text-sm shadow-lg transition" role="alert">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-ink">Patient deleted</p>
              <p className="text-xs text-slate-600">Undo within 5 seconds.</p>
            </div>
            <button
              onClick={undoDelete}
              className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Undo delete patient"
            >
              Undo
            </button>
          </div>
        </div>
      ),
      { id: `delete-patient-${id}`, duration: 5000, position: "top-center" },
    );
  };

  const updateResourcePatients = async (resourceId: string, nextIds: string[]) => {
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/resources/${resourceId}/patients`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${authToken}` },
        body: JSON.stringify({ patientIds: nextIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to assign patient");
      }
      const data = await res.json();
      const updated = data.data as Resource;
      setLibrary((prev) => prev.map((item) => (item.id === resourceId ? updated : item)));
      syncResourceUpdateInChat(updated);
      pushNotice("Updated patient assignment", "success");
    } catch (err) {
      console.error(err);
      pushNotice("Could not update patient assignment.", "error");
    }
  };

  const handleAssignPatient = (resource: Resource, patientId: string) => {
    if (!patientId) return;
    const current = resource.patientIds || [];
    if (current.includes(patientId)) return;
    const next = [...current, patientId];
    updateResourcePatients(resource.id, next);
  };

  const handleRemovePatient = (resource: Resource, patientId: string) => {
    const current = resource.patientIds || [];
    const next = current.filter((id) => id !== patientId);
    updateResourcePatients(resource.id, next);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const customFolders = folders.filter((f) => !f.isLocked);
    window.localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(customFolders));
  }, [folders]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FOLDER_MAP_STORAGE_KEY, JSON.stringify(resourceFolderMap));
  }, [resourceFolderMap]);

  useEffect(() => {
    if (library.length === 0) return;
    setResourceFolderMap((prev) => {
      const ids = new Set(library.map((r) => r.id));
      const next = { ...prev };
      let changed = false;
      Object.keys(next).forEach((key) => {
        if (!ids.has(key)) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [library]);

  const filteredLibrary = useMemo(
    () =>
      library.filter((item) => {
        if (selectedFolderId !== "all") {
          if (selectedFolderId === "unsorted") {
            if (resourceFolderMap[item.id]) return false;
          } else if (resourceFolderMap[item.id] !== selectedFolderId) {
            return false;
          }
        }

        if (!libraryFilter.trim()) return true;
        const q = libraryFilter.toLowerCase();
        const haystack = `${item.title} ${item.description} ${(item.tags || []).join(" ")} ${item.type ?? ""}`.toLowerCase();
        return haystack.includes(q);
      }),
    [library, resourceFolderMap, selectedFolderId, libraryFilter],
  );

  const handleCreateFolder = () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    const newFolder: Folder = { id: `folder-${Date.now()}`, name: trimmed };
    setFolders((prev) => [...prev, newFolder]);
    setSelectedFolderId(newFolder.id);
    setNewFolderName("");
    pushNotice("Folder created", "success");
  };

  const handleResourceDrop = (folderId: string) => {
    if (!draggingResourceId) return;
    if (folderId === "all") {
      setDraggingResourceId(null);
      return;
    }
    const currentFolder = resourceFolderMap[draggingResourceId];
    if ((folderId === "unsorted" && !currentFolder) || currentFolder === folderId) {
      pushNotice("Resource already there", "info");
      setDraggingResourceId(null);
      return;
    }
    setResourceFolderMap((prev) => {
      const next = { ...prev };
      delete next[draggingResourceId];
      if (folderId === "unsorted") {
        // no folder assignment keeps it out of other folders
      } else {
        next[draggingResourceId] = folderId;
      }
      return next;
    });
    if (folderId !== "all") {
      setSelectedFolderId(folderId);
    }
    setDraggingResourceId(null);
    const folderName = folders.find((f) => f.id === folderId)?.name || "Folder";
    pushNotice(`Moved to "${folderName}"`, "info");
  };

  const handleRenameFolder = (folderId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditingFolderId(null);
      return;
    }
    setFolders((prev) =>
      prev.map((f) => (f.id === folderId ? { ...f, name: trimmed } : f)),
    );
    setEditingFolderId(null);
  };

  const handleDownload = async (resource: Resource) => {
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    const normalized = normalizeUrl(resource.url);
    if (!normalized) return;
    try {
      const res = await fetch(normalized, { headers: { Authorization: `Basic ${authToken}` } });
      if (!res.ok) {
        throw new Error("Download failed");
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = resource.title ? resource.title.replace(/\s+/g, "_") : "resource";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      pushNotice("Download started", "info");
    } catch (err) {
      console.error(err);
      setFileStatus("Could not download file. Please try again.");
      pushNotice("Download failed", "error");
    }
  };

  

  const handleSend = async () => {
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    const trimmed = input.trim();
    if (!trimmed) return;

    const historyPayload: ChatPayloadMessage[] = [
      ...historyForApi,
      { role: "user", content: trimmed },
    ];
    const nextMessages: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${authToken}` },
        body: JSON.stringify({ message: trimmed, history: historyPayload }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        if (err.fallback) {
          const fallbackMessage: Message = {
            role: "assistant",
            content: err.fallback.reply || "Assistant unavailable; showing local matches.",
            resources: err.fallback.resources || [],
          };
          setMessages([...nextMessages, fallbackMessage]);
          return;
        }
        throw new Error(err.error || "Chat request failed");
      }

      const data = await res.json();
      const assistantMessage: Message = {
        role: "assistant",
        content: data.reply || "I couldn't generate a response.",
        resources: data.resources || [],
      };
      setMessages([...nextMessages, assistantMessage]);
    } catch (error) {
      console.error(error);
      const errorMessage: Message = {
        role: "assistant",
        content:
          error instanceof Error
            ? `I ran into an issue reaching the assistant: ${error.message}`
            : "I ran into an issue reaching the assistant. Please check the server or your API key.",
      };
      setMessages([...nextMessages, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    if (hasFile && hasLink) {
      pushNotice("Choose either a link or a file, not both.", "error");
      return;
    }
    if (!uploadForm.title || !uploadForm.description) {
      pushNotice("Title and description are required.", "error");
      return;
    }

    const titleKey = uploadForm.title.trim().toLowerCase();
    const duplicate = library.some((r) => (r.title || "").trim().toLowerCase() === titleKey);
    if (duplicate) {
      pushNotice("A resource with this title already exists. Rename and try again.", "error");
      return;
    }

    setUploading(true);

    const normalizedTags: string[] = Array.isArray(uploadForm.tags)
      ? uploadForm.tags
      : uploadForm.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);

    try {
      const res = await fetch(`${API_BASE}/api/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${authToken}` },
        body: JSON.stringify({
          ...uploadForm,
          tags: normalizedTags,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || "Upload failed");
      }

      const data = await res.json();
      setLibrary((prev) => [data.data, ...prev]);
      closeUploadModal();
      setUploadForm({
        title: "",
        description: "",
        url: "",
        fileId: "",
        tags: "",
        ageRange: "",
        type: "",
        uploadedBy: "",
      });
      pushNotice("Resource uploaded successfully", "success");
    } catch (err) {
      console.error(err);
      pushNotice("Upload failed. Please try again.", "error");
    } finally {
      setUploading(false);
    }
  };

  const handleUpdate = async (e: FormEvent) => {
    e.preventDefault();
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    if (hasFile && hasLink) {
      pushNotice("Choose either a link or a file, not both.", "error");
      return;
    }
    if (!editResourceId || !uploadForm.title || !uploadForm.description) {
      pushNotice("Title and description are required.", "error");
      return;
    }

    setUploading(true);
    const normalizedTags: string[] = Array.isArray(uploadForm.tags)
      ? uploadForm.tags
      : uploadForm.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);

    try {
      const res = await fetch(`${API_BASE}/api/resources/${editResourceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${authToken}` },
        body: JSON.stringify({
          ...uploadForm,
          tags: normalizedTags,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || "Update failed");
      }

      const data = await res.json();
      setLibrary((prev) => prev.map((item) => (item.id === editResourceId ? data.data : item)));
      syncResourceUpdateInChat(data.data);
      closeUploadModal();
      setEditResourceId(null);
      setUploadForm({
        title: "",
        description: "",
        url: "",
        fileId: "",
        tags: "",
        ageRange: "",
        type: "",
        uploadedBy: "",
      });
      pushNotice("Resource updated", "success");
    } catch (err) {
      console.error(err);
      pushNotice("Update failed. Please try again.", "error");
    } finally {
      setUploading(false);
    }
  };

  const onDrop = async (acceptedFiles: File[]) => {
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    if (hasLink) {
      pushNotice("Remove the link to attach a file, or keep the link instead.", "error");
      return;
    }
    const file = acceptedFiles[0];
    if (!file) return;

    setFileLoading(true);
    setFileStatus("Processing file...");
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_BASE}/api/upload-file`, {
        method: "POST",
        body: formData,
        headers: { Authorization: `Basic ${authToken}` },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unable to process file." }));
        throw new Error(err.error || "Unable to process file.");
      }

      const data = await res.json();

      setUploadForm((prev) => ({
        ...prev,
        title: prev.title || data.filename,
        description: prev.description || data.suggested?.summary || "Add a brief description",
        url: data.url ? `${API_BASE}${data.url}` : prev.url,
        fileId: prev.fileId || data.fileId || "",
        tags:
          Array.isArray(data.suggested?.tags) && data.suggested.tags.length > 0
            ? data.suggested.tags.join(", ")
            : prev.tags,
        ageRange: data.suggested?.ageRange || prev.ageRange,
        type:
          data.suggested?.type ||
          prev.type ||
          (file.type?.includes("pdf") ? "PDF" : file.type?.includes("word") ? "DOCX" : file.type || "Document"),
      }));
      setFileStatus(`Loaded ${data.filename || file.name}`);
    } catch (err) {
      console.error(err);
      const message =
        err instanceof Error ? err.message : "Could not process that file. Try a PDF/DOCX under 15 MB.";
      setFileStatus(message);
    } finally {
      setFileLoading(false);
    }
  };

  const handleDelete = (id?: string) => {
    if (!authToken) {
      pushNotice("Please sign in first.", "error");
      return;
    }
    if (!id) return;
    const resource = library.find((r) => r.id === id);
    if (!resource) return;
    const prevFolder = resourceFolderMap[id];

    const affectedMsgIndices = messages.reduce<number[]>((acc, msg, idx) => {
      if (msg.resources?.some((r) => r.id === id)) acc.push(idx);
      return acc;
    }, []);

    setLibrary((prev) => prev.filter((r) => r.id !== id));
    setResourceFolderMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    syncResourceDeleteInChat(id);

    const undoDelete = () => {
      const timerId = deleteTimers.current[id];
      if (timerId) {
        clearTimeout(timerId);
        delete deleteTimers.current[id];
      }
      setLibrary((prev) => [resource, ...prev]);
      setResourceFolderMap((prev) => {
        if (!prevFolder) return prev;
        return { ...prev, [id]: prevFolder };
      });
      setMessages((prev) =>
        prev.map((msg, idx) =>
          affectedMsgIndices.includes(idx)
            ? {
                ...msg,
                resources: msg.resources ? [...msg.resources, resource] : [resource],
              }
            : msg,
        ),
      );
      toast.dismiss(`delete-${id}`);
      pushNotice("Delete restored", "info");
    };

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/resources/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Basic ${authToken}` },
        });
        if (!res.ok) {
          throw new Error("Delete failed");
        }
        delete deleteTimers.current[id];
        pushNotice("Resource deleted", "info");
      } catch (err) {
        console.error(err);
        setLibrary((prev) => [resource, ...prev]);
        setResourceFolderMap((prev) => {
          if (!prevFolder) return prev;
          return { ...prev, [id]: prevFolder };
        });
        setMessages((prev) =>
          prev.map((msg, idx) =>
            affectedMsgIndices.includes(idx)
              ? {
                  ...msg,
                  resources: msg.resources ? [...msg.resources, resource] : [resource],
                }
              : msg,
          ),
        );
        pushNotice("Delete failed. Restored.", "error");
      }
    }, 3500);

    deleteTimers.current[id] = timer;

    toast.custom(() => (
      <div
        className="rounded-2xl border bg-white px-4 py-3 text-sm shadow-lg transition"
        role="alert"
        aria-live="assertive"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-ink">Resource deleted</p>
            <p className="text-xs text-slate-600">Undo within a few seconds.</p>
          </div>
          <button
            onClick={undoDelete}
            className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Undo delete"
          >
            Undo
          </button>
        </div>
      </div>
    ), { id: `delete-${id}`, duration: 3500, position: "top-center" });
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    disabled: hasLink,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    },
  });

  const renderResources = (resources?: Resource[]) => {
    if (!resources || resources.length === 0) return null;

    return (
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {resources.map((res) => (
          <div key={res.id} className="rounded-xl border border-slate-200 bg-white/70 p-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">{res.title}</p>
              {res.type && (
                <span className="rounded-full bg-accentSoft px-2 py-0.5 text-[11px] font-medium text-accent">
                  {formatType(res.type) || "Resource"}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600">{res.insight || res.description}</p>
            {res.insight && (
              <p className="text-xs text-slate-500">
                {res.description}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {res.tags?.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                >
                  {tag}
                </span>
              ))}
              {res.fileId && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                  File attached
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {(res.patientIds || []).map((pid) => (
                <span
                  key={pid}
                  className="flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700"
                >
                  {patientMap[pid]?.name || "Patient"}
                  <button
                    onClick={() => handleRemovePatient(res, pid)}
                    className="text-[10px] text-orange-700 hover:text-orange-900"
                    aria-label="Remove patient"
                  >
                    ✕
                  </button>
                </span>
              ))}
              {patients.length > 0 && (
                <select
                  onChange={(e) => {
                    handleAssignPatient(res, e.target.value);
                    e.currentTarget.value = "";
                  }}
                  defaultValue=""
                  className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-ink outline-none focus:border-accent"
                >
                  <option value="" disabled>
                    Assign to patient
                  </option>
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                  {res.ageRange || "All ages"}
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                  {formatType(res.type) || "Resource"}
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                  {formatDate(res.createdAt)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setEditResourceId(res.id);
                    setUploadForm({
                      title: res.title || "",
                      description: res.description || "",
                      url: res.url || "",
                      fileId: res.fileId || "",
                      tags: res.tags || [],
                      ageRange: res.ageRange || "",
                      type: res.type || "",
                      uploadedBy: res.uploadedBy || "",
                    });
                    setReturnToLibraryAfterEdit(true);
                    setShowLibrary(false);
                    setShowUpload(true);
                  }}
                  className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-accent transition hover:border-accent hover:bg-accentSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label="Edit resource"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(res.id)}
                  className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-red-500 transition hover:border-red-200 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  aria-label="Delete resource"
                >
                  Delete
                </button>
                {res.url && res.url.startsWith("http") && !res.fileId ? (
                  <a
                    href={res.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-ink/20 px-3 py-1 text-[11px] font-semibold text-ink transition hover:border-accent hover:text-accent"
                    aria-label="Open link"
                  >
                    Open link
                  </a>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => res.url && handleView(res)}
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        res.url ? "border border-ink/20 text-ink hover:border-accent hover:text-accent" : "cursor-not-allowed border border-slate-200 text-slate-500"
                      }`}
                      disabled={!res.url}
                      aria-label={res.url ? "View resource" : "View unavailable"}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => res.url && handleDownload(res)}
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        res.url ? "bg-accent text-white hover:brightness-110" : "cursor-not-allowed bg-slate-200 text-slate-500"
                      }`}
                      disabled={!res.url}
                      aria-label={res.url ? "Download resource" : "Download unavailable"}
                    >
                      {res.url ? "Download" : "No link"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const handleKeyPress = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="min-h-screen bg-white text-ink">
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            borderRadius: "14px",
            padding: "10px 12px",
            fontSize: "14px",
            backgroundColor: "#ffffff",
            color: "#0b1021",
            border: "1px solid #e2e8f0",
          },
          success: { icon: "\u{1F427}" },
          duration: 3200,
          ariaProps: { role: "status", "aria-live": "polite" },
        }}
      />
      {!authToken ? (
        <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-foam via-white to-sky/20 px-4">
          <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="text-center">
              <p className="text-xs uppercase tracking-[0.25em] text-slate-600">Speechie Library</p>
              <h1 className="mt-2 text-2xl font-semibold text-ink">Resource Library for Speech Pathologists</h1>
              <p className="mt-2 text-sm text-slate-600">Sign in to access your resources.</p>
            </div>
            <div className="mt-6 space-y-3">
              <div className="space-y-1">
                <label className="text-sm font-medium text-ink">Username</label>
                <input
                  value={loginForm.username}
                  onChange={(e) => setLoginForm((p) => ({ ...p, username: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                  placeholder=""
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-ink">Password</label>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm((p) => ({ ...p, password: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                  placeholder=""
                />
              </div>
              <button
                onClick={handleLogin}
                className="w-full rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
              >
                Sign in
              </button>
            </div>
            <p className="mt-4 text-center text-xs text-slate-500">
              Use the credentials provided by your admin to access your library.
            </p>
          </div>
        </div>
      ) : (
      <div className="mx-auto max-w-7xl px-6 py-8">
        <header className="relative mb-6 flex flex-col gap-4 rounded-3xl bg-gradient-to-br from-accentSoft via-foam to-sky/20 p-6 shadow-lg ring-1 ring-white/50 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-slate-600">Speechie Library</p>
              <h1 className="mt-2 text-3xl font-semibold text-ink">
                Resource Library for Speech Pathologists
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => setShowLibrary(true)}
                className="rounded-full border border-ink/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink shadow-sm transition hover:-translate-y-[1px] hover:border-ink/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Library
              </button>
              <button
                onClick={() => setShowPatientModal(true)}
                className="rounded-full border border-ink/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink shadow-sm transition hover:-translate-y-[1px] hover:border-ink/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label="Manage patients"
              >
                Manage patients
              </button>
              <button
                onClick={() => setShowUpload(true)}
                className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-[1px] hover:bg-ink/90"
              >
                Upload resource
              </button>
            </div>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[320px,1fr]">
          <aside className="flex flex-col gap-4 rounded-3xl bg-white/80 p-4 shadow-lg ring-1 ring-white/60 backdrop-blur">
            <div className="rounded-2xl border border-white/60 bg-gradient-to-br from-white via-foam to-sky/10 p-4 shadow-sm">
              <p className="text-sm font-semibold text-ink">Quick prompts</p>
              <div className="mt-3 flex flex-col gap-2">
                {quickPrompts.map((prompt) => (
                  <div
                    key={prompt}
                    className="flex items-center gap-2 rounded-xl border border-slate-200/70 bg-white/80 px-3 py-2 text-sm text-slate-700 transition hover:-translate-y-[1px] hover:border-accent hover:bg-accentSoft/60"
                  >
                    <button
                      onClick={() => setInput(prompt)}
                      className="flex-1 text-left"
                    >
                      {prompt}
                    </button>
                    <button
                      onClick={() => setQuickPrompts((prev) => prev.filter((p) => p !== prompt))}
                      aria-label={`Delete prompt ${prompt}`}
                      className="rounded-full border border-slate-200 px-2 py-1 text-xs font-semibold text-red-500 transition hover:border-red-200 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Add your quick prompt"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <button
                  onClick={() => {
                    const trimmed = customPrompt.trim();
                    if (!trimmed) return;
                    setQuickPrompts((prev) => [trimmed, ...prev].slice(0, 12));
                    setCustomPrompt("");
                  }}
                  className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
                >
                  Add
                </button>
              </div>
            </div>
            <div className="mt-auto rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 shadow-sm">
              <div className="text-xs">
                <p className="font-semibold text-ink">{userProfile?.name || "Signed in"}</p>
                <p className="text-slate-500">Secure session</p>
              </div>
              <button
                onClick={handleLogout}
                className="mt-2 w-full rounded-full bg-red-500 px-4 py-2 text-[11px] font-semibold text-white shadow-sm transition hover:-translate-y-[1px] hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
              >
                Logout
              </button>
            </div>
          </aside>

          <main className="rounded-3xl border border-white/70 bg-white/90 shadow-xl backdrop-blur">
            <div className="flex h-[75vh] flex-col">
              <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
                {messages.map((msg, idx) => (
                  <div key={idx} className="flex flex-col gap-2">
                    {msg.role === "assistant" ? (
                      <div className="max-w-3xl rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-relaxed text-ink">
                        <div className="prose prose-sm max-w-none prose-p:mt-2 prose-p:first:mt-0 prose-a:text-accent prose-a:underline">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ) : (
                      <div className="ml-auto max-w-3xl rounded-2xl bg-gradient-to-br from-accent via-accent to-grape px-4 py-3 text-sm leading-relaxed text-white shadow">
                        {msg.content.split("\n").map((line, i) => (
                          <p key={i} className="mt-1 first:mt-0">
                            {line}
                          </p>
                        ))}
                      </div>
                    )}
                    {msg.role === "assistant" && renderResources(msg.resources)}
                  </div>
                ))}
                {isLoading && (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span className="h-2 w-2 animate-ping rounded-full bg-accent"></span>
                    Thinking...
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="border-t border-slate-100 p-4">
                <div className="flex items-end gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyPress}
                    placeholder="Ask for articulation drills, AAC boards, language checklists..."
                    className="max-h-32 w-full resize-none border-none bg-transparent text-sm text-ink outline-none focus:ring-0"
                    rows={2}
                  />
                  <button
                    onClick={handleSend}
                    disabled={isLoading}
                    className="h-10 min-w-[90px] rounded-full bg-gradient-to-r from-accent to-grape px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Send
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-500">Connected to OpenAI for responses.</p>
              </div>
            </div>
          </main>
        </div>
      </div>
      )}

      {showLibrary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur">
          <div className="flex w-full max-w-6xl flex-col gap-4 rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-ink">Library</h2>
                <p className="text-sm text-slate-600">
                  Drag resources into folders to organize them. Rename folders to keep everything tidy.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={libraryFilter}
                  onChange={(e) => setLibraryFilter(e.target.value)}
                  placeholder="Filter by title, tag, type..."
                  className="w-56 rounded-full border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                  aria-label="Filter library"
                />
                <button
                  onClick={() => setShowLibrary(false)}
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label="Close library"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[260px,1fr]">
              <aside className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex items-center gap-2">
                  <input
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateFolder();
                    }}
                    placeholder="New folder"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                  <button
                    onClick={handleCreateFolder}
                    className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
                  >
                    Add
                  </button>
                </div>

                <div className="space-y-1">
                  {folders.map((folder) => {
                    const count =
                      folder.id === "all"
                        ? library.length
                        : folder.id === "unsorted"
                          ? library.filter((r) => !resourceFolderMap[r.id]).length
                          : library.filter((r) => resourceFolderMap[r.id] === folder.id).length;

                    return (
                      <div
                        key={folder.id}
                        onClick={() => setSelectedFolderId(folder.id)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          handleResourceDrop(folder.id);
                        }}
                        className={`flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2 transition ${
                          selectedFolderId === folder.id
                            ? "border-accent bg-white shadow-sm"
                            : "border-transparent hover:border-slate-200 hover:bg-white"
                        } ${draggingResourceId ? "border-dashed" : ""}`}
                      >
                        <div className="flex flex-col">
                          {editingFolderId === folder.id ? (
                            <input
                              autoFocus
                              defaultValue={folder.name}
                              onBlur={(e) => handleRenameFolder(folder.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleRenameFolder(folder.id, (e.target as HTMLInputElement).value);
                                if (e.key === "Escape") setEditingFolderId(null);
                              }}
                              className="rounded-lg border border-slate-200 px-2 py-1 text-sm outline-none focus:border-accent"
                            />
                          ) : (
                            <span className="text-sm font-semibold text-ink">{folder.name}</span>
                          )}
                          <span className="text-xs text-slate-500">{count} items</span>
                        </div>
                        {!folder.isLocked && editingFolderId !== folder.id && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingFolderId(folder.id);
                            }}
                            className="text-xs font-semibold text-accent hover:underline"
                          >
                            Rename
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <p className="text-xs text-slate-500">
                  Tip: Drag any resource card onto a folder to file it. Choose "Unsorted" to clear its folder.
                </p>
              </aside>

              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">Resources</p>
                    <p className="text-xs text-slate-500">
                      Viewing {filteredLibrary.length} of {library.length} total
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-slate-500">
                      Drag to organize · Drop on a folder
                    </span>
                    {draggingResourceId && (
                      <span className="rounded-full bg-accentSoft px-2 py-1 text-[11px] font-semibold text-accent">
                        Dragging
                      </span>
                    )}
                  </div>
                </div>

                {filteredLibrary.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
                    No resources in this view yet. Drag items here or pick a different folder.
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {filteredLibrary.map((res) => (
                      <div
                        key={res.id}
                        draggable
                        onDragStart={() => {
                          if (!res.id) return;
                          setDraggingResourceId(res.id);
                        }}
                        onDragEnd={() => {
                          setDraggingResourceId(null);
                        }}
                        className={`rounded-xl border border-slate-200 bg-white/80 p-3 shadow-sm transition ${
                          draggingResourceId === res.id ? "border-accent ring-2 ring-accent/30" : "hover:-translate-y-[1px]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-ink">{res.title}</p>
                          {res.type && (
                            <span className="rounded-full bg-accentSoft px-2 py-0.5 text-[11px] font-medium text-accent">
                              {formatType(res.type) || "Resource"}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-slate-600">{res.insight || res.description}</p>
                        {res.insight && (
                          <p className="text-xs text-slate-500">
                            {res.description}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1">
                          {res.tags?.slice(0, 4).map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                            >
                              {tag}
                            </span>
                          ))}
                          {res.fileId && (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                              File attached
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {(res.patientIds || []).map((pid) => (
                            <span
                              key={pid}
                              className="flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700"
                            >
                              {patientMap[pid]?.name || "Patient"}
                              <button
                                onClick={() => handleRemovePatient(res, pid)}
                                className="text-[10px] text-orange-700 hover:text-orange-900"
                                aria-label="Remove patient"
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                          {patients.length > 0 && (
                            <select
                              onChange={(e) => {
                                handleAssignPatient(res, e.target.value);
                                e.currentTarget.value = "";
                              }}
                              defaultValue=""
                              className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-ink outline-none focus:border-accent"
                            >
                              <option value="" disabled>
                                Assign to patient
                              </option>
                              {patients.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                              {res.ageRange || "All ages"}
                            </span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                              {formatType(res.type) || "Resource"}
                            </span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                              {formatDate(res.createdAt)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setEditResourceId(res.id);
                                setUploadForm({
                                  title: res.title || "",
                                  description: res.description || "",
                                  url: res.url || "",
                                  fileId: res.fileId || "",
                                  tags: res.tags || [],
                                  ageRange: res.ageRange || "",
                                  type: res.type || "",
                                  uploadedBy: res.uploadedBy || "",
                                });
                                setReturnToLibraryAfterEdit(true);
                                setShowLibrary(false);
                                setShowUpload(true);
                              }}
                              className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-accent transition hover:border-accent hover:bg-accentSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              aria-label="Edit resource"
                            >
                              Edit
                            </button>
                            <div className="flex items-center gap-1">
                              {res.url && res.url.startsWith("http") && !res.fileId ? (
                                <a
                                  href={res.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="rounded-full border border-ink/20 px-3 py-1 text-[11px] font-semibold text-ink transition hover:border-accent hover:text-accent"
                                  aria-label="Open link"
                                >
                                  Open link
                                </a>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => res.url && handleView(res)}
                                    className={`rounded-full px-3 py-1 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                                      res.url ? "border border-ink/20 text-ink hover:border-accent hover:text-accent" : "cursor-not-allowed border border-slate-200 text-slate-500"
                                    }`}
                                    disabled={!res.url}
                                    aria-label={res.url ? "View resource" : "View unavailable"}
                                  >
                                    View
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => res.url && handleDownload(res)}
                                    className={`rounded-full px-3 py-1 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                                      res.url ? "bg-ink text-white hover:brightness-110" : "cursor-not-allowed bg-slate-200 text-slate-500"
                                    }`}
                                    disabled={!res.url}
                                    aria-label={res.url ? "Download resource" : "Download unavailable"}
                                  >
                                    {res.url ? "Download" : "No link"}
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDelete(res.id)}
                                className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-red-500 transition hover:border-red-200 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                                aria-label="Delete resource"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}

      {showPatientModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur">
          <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">Manage patients</h2>
              <button
                onClick={() => setShowPatientModal(false)}
                className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-ink"
              >
                Close
              </button>
            </div>
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-ink">Name</label>
                  <input
                    value={newPatient.name}
                    onChange={(e) => setNewPatient((p) => ({ ...p, name: e.target.value }))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                    placeholder="Patient name"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-ink">Notes (optional)</label>
                  <textarea
                    value={newPatient.notes}
                    onChange={(e) => setNewPatient((p) => ({ ...p, notes: e.target.value }))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                    rows={3}
                    placeholder="Goals, reminders, etc."
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={async () => {
                    await handleAddPatient();
                  }}
                  className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
                >
                  Save patient
                </button>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
                <p className="text-sm font-semibold text-ink">Patients</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {patients.length === 0 ? (
                    <p className="text-xs text-slate-500">No patients yet. Add one to start assigning resources.</p>
                  ) : (
                    patients.map((p) => (
                      <span
                        key={p.id}
                        className="flex items-center gap-3 rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-ink shadow-sm"
                      >
                        {p.name}
                        <button
                          onClick={() => handleDeletePatient(p.id)}
                          className="text-[11px] font-semibold text-red-500 hover:text-red-700"
                          aria-label={`Delete ${p.name}`}
                        >
                          Delete
                        </button>
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showUpload && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4 backdrop-blur">
          <div className="w-full max-w-xl rounded-3xl bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">Upload a resource</h2>
              <button
                onClick={closeUploadModal}
                className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-ink"
              >
                Close
              </button>
            </div>

            <form
              className="mt-4 space-y-3"
              noValidate
              onSubmit={editResourceId ? handleUpdate : handleUpload}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  const formEl = e.currentTarget;
                  if (typeof formEl.requestSubmit === "function") {
                    formEl.requestSubmit();
                  }
                }
              }}
            >
              <div className="space-y-1">
                <label className="text-sm font-medium text-ink">Title</label>
                <input
                  value={uploadForm.title}
                  ref={titleInputRef}
                  onChange={(e) => setUploadForm((prev) => ({ ...prev, title: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                  placeholder="e.g., Articulation Drill Cards - /s/ Sound"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-ink">Description</label>
                <textarea
                  value={uploadForm.description}
                  onChange={(e) =>
                    setUploadForm((prev) => ({ ...prev, description: e.target.value }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                  rows={3}
                  placeholder="What does this resource help with? Any tips for use?"
                />
              </div>
              <div className="space-y-1 max-w-xl mx-auto w-full">
                <label className="text-sm font-medium text-ink">Resource link (optional)</label>
                <input
                  value={hasFile ? "" : uploadForm.url}
                  onChange={(e) =>
                    setUploadForm((prev) => ({
                      ...prev,
                      url: e.target.value,
                      fileId: e.target.value ? "" : prev.fileId,
                    }))
                  }
                  placeholder="https://example.com/resource.pdf"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent disabled:bg-slate-100"
                  disabled={hasFile}
                />
                <p className="text-xs text-slate-500">
                  Paste a link OR upload a file below. Links disable file uploads and vice versa.
                </p>
                {!uploadForm.fileId ? (
                  <>
                    <label className="text-sm font-medium text-ink">Upload file (PDF/DOCX)</label>
                    <div
                      {...getRootProps()}
                      className={`flex flex-col items-center justify-center rounded-xl border border-dashed px-4 py-7 text-center text-sm transition ${
                        hasLink
                          ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
                          : isDragActive
                            ? "cursor-pointer border-accent bg-accentSoft/60 text-accent"
                            : "cursor-pointer border-slate-200 bg-slate-50 text-slate-600"
                      }`}
                    >
                      <input {...getInputProps()} />
                      {hasLink ? (
                        <p className="text-xs text-slate-500">Link in use. Clear the link to attach a file.</p>
                      ) : fileLoading ? (
                        <div className="flex items-center gap-2 text-slate-500">
                          <span className="h-2 w-2 animate-ping rounded-full bg-accent" />
                          Processing file...
                        </div>
                      ) : (
                        <>
                          <p className="font-medium">Drop a PDF/DOCX or click to browse</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Auto-fills title & type from file. Max 15 MB.
                          </p>
                        </>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 text-center">
                      Attach the file, add a title and short description, then save. Tags are optional.
                    </p>
                    {fileStatus && (
                      <p className="mt-1 text-xs text-emerald-600 text-center">
                        {fileStatus}
                      </p>
                    )}
                  </>
                ) : (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-ink">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold">File ready to save</p>
                      <button
                        type="button"
                        onClick={() => {
                          setUploadForm((prev) => ({ ...prev, fileId: "", url: "" }));
                          setFileStatus(null);
                        }}
                        className="text-xs font-semibold text-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">PDF/DOCX uploaded. Fill in details and save.</p>
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-sm font-medium text-ink">Tags (optional)</label>
                  <input
                    value={Array.isArray(uploadForm.tags) ? uploadForm.tags.join(", ") : uploadForm.tags}
                    onChange={(e) => setUploadForm((prev) => ({ ...prev, tags: e.target.value }))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                    placeholder="articulation, /s/, minimal pairs"
                  />
                  {tagList.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {tagList.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowMoreDetails((prev) => !prev)}
                  className="flex items-center gap-2 text-sm font-semibold text-ink"
                >
                  <span>More details (optional)</span>
                  <span className="text-xs text-slate-500">{showMoreDetails ? "Hide" : "Show"}</span>
                </button>
                {showMoreDetails && (
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-ink">Age range</label>
                      <input
                        value={uploadForm.ageRange}
                        onChange={(e) => setUploadForm((prev) => ({ ...prev, ageRange: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                        placeholder="All ages"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-ink">Type</label>
                      <input
                        value={uploadForm.type}
                        onChange={(e) => setUploadForm((prev) => ({ ...prev, type: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                        placeholder="PDF, board, checklist"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-ink">Uploaded by</label>
                      <input
                        value={uploadForm.uploadedBy}
                        onChange={(e) =>
                          setUploadForm((prev) => ({ ...prev, uploadedBy: e.target.value }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-accent"
                        placeholder="Your name/team"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <p className="text-xs text-slate-500 mr-auto">Tip: Press Ctrl/Cmd + Enter to save quickly.</p>
                <button
                  type="button"
                  onClick={closeUploadModal}
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-ink"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {uploading ? "Uploading..." : "Save resource"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
