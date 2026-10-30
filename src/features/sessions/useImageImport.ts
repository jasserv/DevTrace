import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type RefObject } from "react";

import { useToast } from "../../components";
import { api, toApiError, type ImportedImage } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "../../lib/validation";

interface ImageImportOptions {
  sessionId: string;
  /** False when the session is read-only; drops and pastes then explain why nothing happened. */
  editable: boolean;
  readOnlyReason: string;
  /** Called after each image is stored. */
  onImported: (result: ImportedImage) => void;
}

export interface ImageImport {
  /** Opens the system file chooser. With an event id, images are attached to that event. */
  chooseFiles: (eventId?: string) => void;
  /** Spread onto a hidden `<input>`; the browser's own file chooser is used (no file paths reach the app). */
  inputProps: {
    ref: RefObject<HTMLInputElement | null>;
    type: "file";
    accept: string;
    multiple: true;
    hidden: true;
    tabIndex: -1;
    "aria-hidden": true;
    "data-testid": string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  };
  /** Spread onto the element that accepts dropped files. */
  dropZoneProps: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  /** True while files are dragged over the drop zone. */
  dragging: boolean;
  /** Images still being added. */
  pending: number;
}

const hasFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");

function displayName(file: File, source: "file" | "clipboard") {
  return source === "clipboard" ? "The pasted image" : file.name ? `\u201c${file.name}\u201d` : "The image";
}

/**
 * Adds user-provided images to a session from the file chooser, the clipboard (Ctrl+V outside
 * text fields) or drag and drop. Image bytes are sent to the backend, which checks the content,
 * stores the file and records it. Files are added one at a time, in order.
 */
export function useImageImport({ sessionId, editable, readOnlyReason, onImported }: ImageImportOptions): ImageImport {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const targetEventRef = useRef<string | undefined>(undefined);
  const dragDepth = useRef(0);
  const onImportedRef = useRef(onImported);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    onImportedRef.current = onImported;
  }, [onImported]);

  const importFiles = useCallback(
    async (files: File[], source: "file" | "clipboard", eventId?: string) => {
      if (files.length === 0) return;
      setPending((count) => count + files.length);
      let added: ImportedImage | null = null;
      let addedCount = 0;
      for (const file of files) {
        try {
          if (file.type && !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
            throw new Error("This file is not a supported image. Use a PNG, JPEG, GIF or WebP file.");
          }
          if (file.size > MAX_IMAGE_BYTES) {
            throw new Error(`The image is ${formatBytes(file.size)}. Images must be 25 MB or smaller.`);
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          added = await api.attachments.importImage(bytes, {
            sessionId,
            eventId,
            fileName: file.name || undefined,
            source,
          });
          addedCount += 1;
          onImportedRef.current(added);
        } catch (raw) {
          toast.error(`${displayName(file, source)} was not added`, toApiError(raw).message);
        } finally {
          setPending((count) => count - 1);
        }
      }
      if (addedCount > 1) toast.success(`${addedCount} screenshots added`);
      else if (added) toast.success(eventId ? "Screenshot attached" : "Screenshot added", added.event.title);
    },
    [sessionId, toast],
  );

  // Paste anywhere in the session except text fields and dialogs. Only image files are taken;
  // DevTrace never reads the clipboard on its own.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      if (!editable) {
        toast.info("Screenshot not added", readOnlyReason);
        return;
      }
      void importFiles(files, "clipboard");
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [editable, readOnlyReason, importFiles, toast]);

  const chooseFiles = useCallback((eventId?: string) => {
    targetEventRef.current = eventId;
    const input = inputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }, []);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void importFiles(files, "file", targetEventRef.current);
  };

  const dropZoneProps: ImageImport["dropZoneProps"] = {
    onDragEnter: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = editable ? "copy" : "none";
    },
    onDragLeave: (event) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!editable) {
        toast.info("Nothing was added", readOnlyReason);
        return;
      }
      void importFiles(Array.from(event.dataTransfer.files), "file");
    },
  };

  return {
    chooseFiles,
    inputProps: {
      ref: inputRef,
      type: "file",
      accept: ACCEPTED_IMAGE_TYPES.join(","),
      multiple: true,
      hidden: true,
      tabIndex: -1,
      "aria-hidden": true,
      "data-testid": "image-file-input",
      onChange,
    },
    dropZoneProps,
    dragging,
    pending,
  };
}
