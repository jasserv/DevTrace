import type { ReactNode } from "react";

import { evidenceUrl, type PlaybookAsset } from "../../lib/api";
import { cx } from "../../lib/cx";
import styles from "./PlaybookImage.module.css";

interface PlaybookImageProps {
  asset: PlaybookAsset | undefined;
  /** Accessible description, for example "Screenshot for step 2". */
  alt: string;
  /** Larger rendering for reading views. */
  large?: boolean;
  /** Extra controls next to the image (for example a remove button). */
  children?: ReactNode;
}

/**
 * A screenshot copied into a playbook, with its highlight boxes numbered to match the captions
 * below it (the same numbering exports use). Redacted images say so.
 */
export function PlaybookImage({ asset, alt, large = false, children }: PlaybookImageProps) {
  if (!asset) {
    return (
      <div className={styles.figure}>
        <span className={styles.missing}>Image unavailable</span>
        {children}
      </div>
    );
  }
  const { width, height } = asset;
  return (
    <div className={styles.figure}>
      <span className={cx(styles.frame, large && styles.large)}>
        <img src={evidenceUrl(asset.id, asset.sha256)} alt={alt} loading="lazy" draggable={false} />
        {width && height
          ? asset.annotations.map((annotation, index) => (
              <span
                key={annotation.id}
                className={styles.highlight}
                aria-hidden="true"
                style={{
                  left: `${(annotation.x / width) * 100}%`,
                  top: `${(annotation.y / height) * 100}%`,
                  width: `${(annotation.width / width) * 100}%`,
                  height: `${(annotation.height / height) * 100}%`,
                }}
              >
                <span className={styles.number}>{index + 1}</span>
              </span>
            ))
          : null}
      </span>
      {asset.annotations.length > 0 && (
        <ol className={styles.captions} aria-label={`Highlights in ${alt.charAt(0).toLowerCase()}${alt.slice(1)}`}>
          {asset.annotations.map((annotation) => (
            <li key={annotation.id}>{annotation.label || "Highlighted area"}</li>
          ))}
        </ol>
      )}
      {asset.redactedAt && <span className={styles.note}>Redacted</span>}
      {children}
    </div>
  );
}
