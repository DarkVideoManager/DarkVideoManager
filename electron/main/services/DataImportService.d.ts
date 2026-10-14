import type {
  CsvImportPreview,
  CsvImportOptions,
  CsvImportResult,
  DeepDarkDbImportPreview,
  DeepDarkDbImportOptions,
  DeepDarkDbImportResult,
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
export function previewDeepDarkDbImport(
  libraryId: string,
  dbPath: string,
  onProgress?: ProgressHandler,
): Promise<DeepDarkDbImportPreview>
export function importDeepDarkDbData(
  libraryId: string,
  dbPath: string,
  options: DeepDarkDbImportOptions,
  onProgress?: ProgressHandler,
): Promise<DeepDarkDbImportResult>
