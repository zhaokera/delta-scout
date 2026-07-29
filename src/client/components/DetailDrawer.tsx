import { useEffect, useRef } from "react";
import type { Listing } from "../../domain/listing";
import type { ListingHistoryView } from "../api";
import { ListingDetail } from "./ListingDetail";

export function DetailDrawer({
  listing,
  loading,
  history,
  historyLoading,
  historyError,
  onClose
}: {
  listing: Listing;
  loading: boolean;
  history: ListingHistoryView | null;
  historyLoading: boolean;
  historyError: string | null;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousActive =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("[data-detail-close]")
      ?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActive?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="detail-drawer__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="candidate-detail-title"
      >
        <ListingDetail
          listing={listing}
          loading={loading}
          history={history}
          historyLoading={historyLoading}
          historyError={historyError}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
