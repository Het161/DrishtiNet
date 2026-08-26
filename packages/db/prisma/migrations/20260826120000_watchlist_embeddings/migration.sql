-- Enrolled appearance views for a watchlist target.
--
-- On this grid a plate occupies roughly 41 px of a median 164 px vehicle box, so most watchlist
-- entries can never be found by their registration number. They are found by appearance, and that
-- requires at least one reference view of the vehicle to compare against.
--
-- Several rows per entry on purpose: a vehicle enrolled from three angles matches whichever view
-- resembles the camera that sees it, and the matcher takes the best rather than the average — an
-- average across dissimilar angles buries the very evidence that identifies it.
CREATE TABLE "watchlist_embeddings" (
    "id"         TEXT NOT NULL,
    "entry_id"   TEXT NOT NULL,
    -- L2-normalised, so cosine similarity is a dot product.
    "embedding"  DOUBLE PRECISION[] NOT NULL,
    -- Which model produced it. Embeddings from different models are not comparable, and a silent
    -- comparison across two of them would return plausible nonsense.
    "embedding_model" TEXT NOT NULL,
    -- Where this view came from, so an operator can see what the system was told to look for.
    "source_track_id" TEXT,
    "note"       TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "watchlist_embeddings_entry_id_idx" ON "watchlist_embeddings"("entry_id");

ALTER TABLE "watchlist_embeddings"
  ADD CONSTRAINT "watchlist_embeddings_entry_id_fkey"
  FOREIGN KEY ("entry_id") REFERENCES "watchlist_entries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
