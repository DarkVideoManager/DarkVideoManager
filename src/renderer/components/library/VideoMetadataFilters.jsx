import * as React from 'react'
import { useVideoMetadataOptions } from '../../api/useVideos'

export default function VideoMetadataFilters({ libraryId, query, onChange }) {
  const options = useVideoMetadataOptions(libraryId, Boolean(query.removed))
  const categories = options.data?.categories ?? []
  const tags = options.data?.tags ?? []
  const selectClass =
    'max-w-56 min-w-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2">
      <label className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
        카테고리
        <select
          aria-label="카테고리 필터"
          className={selectClass}
          value={query.category === undefined ? '' : `category:${query.category}`}
          onChange={(event) =>
            onChange({ category: event.target.value ? event.target.value.slice(9) : undefined })
          }
        >
          <option value="">모든 카테고리</option>
          <option value="category:">미분류</option>
          {query.category && !categories.includes(query.category) && (
            <option value={`category:${query.category}`}>{query.category}</option>
          )}
          {categories.map((category) => (
            <option key={category} value={`category:${category}`}>
              {category}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
        태그
        <select
          aria-label="태그 필터"
          className={selectClass}
          value={query.tag ?? ''}
          onChange={(event) => onChange({ tag: event.target.value || undefined })}
        >
          <option value="">모든 태그</option>
          {query.tag && !tags.includes(query.tag) && (
            <option value={query.tag}>#{query.tag}</option>
          )}
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              #{tag}
            </option>
          ))}
        </select>
      </label>
      {(query.category !== undefined || query.tag) && (
        <button
          type="button"
          onClick={() => onChange({ category: undefined, tag: undefined })}
          className="text-xs text-indigo-300 underline hover:text-indigo-200"
        >
          분류 필터 해제
        </button>
      )}
      {options.isError ? (
        <span role="alert" className="text-xs text-amber-200">
          분류 목록을 불러오지 못했습니다.{' '}
          <button
            type="button"
            className="underline"
            disabled={options.isFetching}
            onClick={() => void options.refetch()}
          >
            다시 시도
          </button>
        </span>
      ) : (
        <span className="text-xs text-zinc-500">
          {options.isLoading
            ? '분류 목록을 불러오는 중...'
            : '검색창에 #선수명을 입력하면 해당 태그의 영상만 표시합니다.'}
        </span>
      )}
    </div>
  )
}
