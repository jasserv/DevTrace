import type { LinkedSession, ListItem, PlaybookAsset, VersionSnapshot } from "../../lib/api";
import { PlaybookImage } from "./PlaybookImage";
import styles from "./PlaybookReadView.module.css";
import { CLOSING_SECTIONS, LIST_SECTIONS, ORIGIN_LABELS, sourceText, type ListSectionKey } from "./playbookModel";

interface PlaybookReadViewProps {
  snapshot: VersionSnapshot;
  assets: Map<string, PlaybookAsset>;
  sessions: LinkedSession[];
  /** Accessible name of the document, for example "Revision 2". */
  label: string;
}

function OriginTag({ origin }: { origin: ListItem["origin"] }) {
  if (origin === "authored") return null;
  return <span className={styles.tag}>({ORIGIN_LABELS[origin].toLowerCase()})</span>;
}

function ListBlock({ sectionKey, title, items }: { sectionKey: ListSectionKey; title: string; items: ListItem[] }) {
  if (items.length === 0) return null;
  const id = `read-${sectionKey}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>
        {title}
      </h3>
      {sectionKey === "warnings" ? (
        items.map((item) => (
          <div key={item.id} className={styles.warning} role="note">
            <span className={styles.warningLabel}>Warning</span>
            {item.text}
            <OriginTag origin={item.origin} />
          </div>
        ))
      ) : sectionKey === "rollback" ? (
        <ol className={styles.items}>
          {items.map((item) => (
            <li key={item.id} className={styles.text}>
              {item.text}
              <OriginTag origin={item.origin} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className={sectionKey === "verification" ? `${styles.items} ${styles.checklist}` : styles.items}>
          {items.map((item) => (
            <li key={item.id} className={styles.text}>
              {item.text}
              <OriginTag origin={item.origin} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TextBlock({ title, text }: { title: string; text: string }) {
  if (!text.trim()) return null;
  const id = `read-${title.toLowerCase()}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>
        {title}
      </h3>
      <p className={styles.text}>{text}</p>
    </section>
  );
}

/**
 * A playbook version as a read-only document, in the editor's section order. Empty sections are
 * left out; provenance is shown on every step.
 */
export function PlaybookReadView({ snapshot, assets, sessions, label }: PlaybookReadViewProps) {
  const content = snapshot.content;
  const fields: Array<[string, string | null]> = [
    ["Project", snapshot.projectName],
    ["Platform", snapshot.platform],
    ["Product", snapshot.product],
    ["Version", snapshot.productVersion],
    ["Environment", snapshot.environment],
    ["Task type", snapshot.taskType],
    ["Author", snapshot.author],
  ];
  const shown = fields.filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  return (
    <article className={styles.document} aria-label={label}>
      <h2 className={styles.title}>{snapshot.title}</h2>
      {snapshot.summary.trim() && <p className={styles.summary}>{snapshot.summary}</p>}
      {shown.length > 0 && (
        <dl className={styles.meta}>
          {shown.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <TextBlock title="Purpose" text={content.purpose} />
      <TextBlock title="Scope" text={content.scope} />
      {LIST_SECTIONS.map((section) => (
        <ListBlock key={section.key} sectionKey={section.key} title={section.title} items={content[section.key]} />
      ))}
      <section className={styles.section} aria-labelledby="read-steps">
        <h3 id="read-steps" className={styles.sectionTitle}>
          Steps
        </h3>
        {content.steps.length === 0 ? (
          <p className={styles.empty}>This version has no steps.</p>
        ) : (
          <ol className={styles.steps}>
            {content.steps.map((step, index) => {
              const source = sourceText(step, sessions);
              return (
                <li key={step.id} className={styles.step} aria-label={`Step ${index + 1}`}>
                  <div className={styles.stepHeader}>
                    <span className={styles.stepNumber} aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className={styles.stepTitle}>{step.title}</span>
                  </div>
                  <span className={styles.source}>{source ?? ORIGIN_LABELS.authored}</span>
                  {step.instruction.trim() && <p className={styles.text}>{step.instruction}</p>}
                  {step.command.trim() && (
                    <div>
                      <span className={styles.fieldLabel}>Command or configuration</span>
                      <pre className={styles.command}>
                        <code>{step.command}</code>
                      </pre>
                    </div>
                  )}
                  {step.expectedResult.trim() && (
                    <div>
                      <span className={styles.fieldLabel}>Expected result</span>
                      <p className={styles.text}>{step.expectedResult}</p>
                    </div>
                  )}
                  {step.note.trim() && (
                    <div>
                      <span className={styles.fieldLabel}>Note</span>
                      <p className={styles.text}>{step.note}</p>
                    </div>
                  )}
                  {step.assetIds.map((assetId) => (
                    <PlaybookImage key={assetId} asset={assets.get(assetId)} alt={`Screenshot for step ${index + 1}`} large />
                  ))}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {CLOSING_SECTIONS.map((section) => (
        <ListBlock key={section.key} sectionKey={section.key} title={section.title} items={content[section.key]} />
      ))}
    </article>
  );
}
