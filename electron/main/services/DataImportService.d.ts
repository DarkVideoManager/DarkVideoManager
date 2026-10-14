import type {
  CsvImportPreview,
  CsvImportOptions,
  CsvImportResult,
  ImportProgress,
} from '../../../src/shared/types'
type ProgressHandler = (progress: ImportProgress) => void
export function previewCsvImport(
  libraryId: string,
  csvPath: string,
  onProgress?: ProgressHandler,
): Promise<CsvImportPreview>
export function importCsvData(
  libraryId: string,
  csvPath: string,
  options: CsvImportOptions,
  onProgress?: ProgressHandler,
): Promise<CsvImportResult>
