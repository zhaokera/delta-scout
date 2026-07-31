import {
  useId,
  useState,
  type FormEvent,
  type KeyboardEvent
} from "react";

import {
  MANUAL_REVIEW_REASON_LABELS,
  ManualReviewReasonSchema,
  parseManualExclusionInput,
  type ManualExclusionInput,
  type ManualReviewReason,
  type ReviewedListing
} from "../../domain/manualReview";

export interface ManualReviewDialogProps {
  listing: ReviewedListing;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (
    input: ManualExclusionInput
  ) => void | Promise<void>;
}

export function ManualReviewDialog({
  listing,
  pending,
  error,
  onCancel,
  onSubmit
}: ManualReviewDialogProps) {
  const titleId = useId();
  const reasonsId = useId();
  const [reason, setReason] =
    useState<ManualReviewReason | null>(null);
  const [note, setNote] = useState("");
  const [validationError, setValidationError] =
    useState<string | null>(null);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault();
    if (reason === null || pending) return;

    let input: ManualExclusionInput;
    try {
      input = parseManualExclusionInput({ reason, note });
    } catch {
      setValidationError(
        reason === "other"
          ? "选择其他时请填写说明"
          : "人工淘汰信息无效"
      );
      return;
    }

    setValidationError(null);
    try {
      await onSubmit(input);
    } catch {
      // The parent owns the safe server error and keeps this form mounted.
    }
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLDivElement>
  ): void {
    if (event.key === "Escape" && !pending) {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="manual-review-dialog__backdrop">
      <div
        className="manual-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <p className="manual-review-dialog__eyebrow">MANUAL REVIEW</p>
        <h2 id={titleId}>人工淘汰账号</h2>
        <p className="manual-review-dialog__listing">
          {listing.title}
        </p>
        <p className="manual-review-dialog__hint">
          淘汰后该账号不会再进入候选池或 Top30，之后可在“已淘汰”中恢复。
        </p>

        <form onSubmit={(event) => void handleSubmit(event)}>
          <p id={reasonsId} className="manual-review-dialog__label">
            淘汰原因
          </p>
          <div
            className="manual-review-dialog__reasons"
            role="radiogroup"
            aria-labelledby={reasonsId}
          >
            {ManualReviewReasonSchema.options.map((value, index) => (
              <label
                className="manual-review-dialog__reason"
                key={value}
              >
                <input
                  type="radio"
                  name="manual-review-reason"
                  value={value}
                  checked={reason === value}
                  disabled={pending}
                  autoFocus={index === 0}
                  onChange={() => {
                    setReason(value);
                    setValidationError(null);
                  }}
                />
                <span>{MANUAL_REVIEW_REASON_LABELS[value]}</span>
              </label>
            ))}
          </div>

          <label className="manual-review-dialog__note">
            <span>补充说明（选填）</span>
            <textarea
              value={note}
              maxLength={500}
              rows={4}
              disabled={pending}
              aria-label="补充说明（选填）"
              aria-invalid={validationError !== null}
              onChange={(event) => {
                setNote(event.target.value);
                setValidationError(null);
              }}
            />
            <span className="manual-review-dialog__counter">
              {note.length}/500
            </span>
          </label>

          {validationError ? (
            <p className="manual-review-dialog__error" role="alert">
              {validationError}
            </p>
          ) : null}
          {error ? (
            <p className="manual-review-dialog__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="manual-review-dialog__actions">
            <button
              type="button"
              disabled={pending}
              onClick={onCancel}
            >
              取消
            </button>
            <button
              className="manual-review-dialog__danger"
              type="submit"
              disabled={pending || reason === null}
            >
              {pending ? "正在淘汰…" : "确认淘汰"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
