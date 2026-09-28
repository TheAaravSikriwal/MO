export type ReportStatus = 'open' | 'cleaned'
export type ModerationStatus = 'pending' | 'approved' | 'rejected'

/** The minimum a report must expose for the map engine to weigh it. */
export interface WeighableReport {
  id: string
  status: ReportStatus
  moderationStatus: ModerationStatus
  /** Distinct people who confirmed this report. Severity is derived, never chosen. */
  voteCount: number
  /** The stored H3 cells, keyed `cell_r1` … `cell_r12` (see STORED_RESOLUTIONS). */
  cells: Record<string, string>
}

/** One aggregated cell, ready to colour. */
export interface WeightedCell {
  cell: string
  weight: number
  reportCount: number
}
