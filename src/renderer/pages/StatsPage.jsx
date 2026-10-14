/* eslint-disable react/prop-types */
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useLibraryStore } from '../store/libraryStore'
import { useLibraries } from '../api/useLibraries'

const PERIOD_OPTIONS = [7, 30, 90, 365]
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const number = (value) => Number(value || 0).toLocaleString('ko-KR')
const percentage = (count, total) => (total > 0 ? Math.round((count / total) * 100) : 0)
const cardClass = 'min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/70'

function StatsPage() {
  const activeLibraryId = useLibraryStore((state) => state.activeLibraryId)
  const openedLibraryId = useLibraryStore((state) => state.openedLibraryId)
  const libraries = useLibraries()
  const navigate = useNavigate()
  const [days, setDays] = React.useState(30)
  const [dailyMetric, setDailyMetric] = React.useState('watchedSec')
  const isLibraryReady = !!activeLibraryId && openedLibraryId === activeLibraryId
  const query = useQuery({
    queryKey: ['stats', activeLibraryId, days],
    queryFn: async () => {
      const result = await window.api.stats.get(activeLibraryId, days)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    enabled: isLibraryReady,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 1,
  })
  const stats = query.data
  const libraryName = libraries.data?.find((library) => library.id === activeLibraryId)?.name

  if (!activeLibraryId || !isLibraryReady) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-sm text-zinc-500">
        {!activeLibraryId ? '라이브러리를 먼저 선택해주세요.' : '라이브러리를 여는 중입니다...'}
      </div>
    )
  }

  return (
    <div
      data-testid="stats-page"
      className="h-full min-w-0 w-full flex-1 overflow-y-auto p-4 text-zinc-100 sm:p-6"
    >
      <div
        data-testid={stats ? 'stats-dashboard' : undefined}
        className="mx-auto flex w-full max-w-[1440px] flex-col gap-7"
      >
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">통계</h1>
            <p className="mt-1 break-all text-sm text-zinc-400">
              {libraryName || '현재 라이브러리'}의 시청 기록과 컬렉션을 살펴보세요.
            </p>
          </div>
          <button
            type="button"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            aria-label="통계 새로고침"
            className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {query.isFetching ? '불러오는 중…' : '↻ 새로고침'}
          </button>
        </header>

        <section aria-labelledby="stats-activity-heading" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="stats-activity-heading" className="text-base font-semibold">
                시청 활동
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                {stats
                  ? `${stats.period.startDate} – ${stats.period.endDate} · 오늘 포함`
                  : `최근 ${days}일 · 오늘 포함`}
              </p>
            </div>
            <div
              role="group"
              aria-label="통계 기간"
              className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1"
            >
              {PERIOD_OPTIONS.map((period) => (
                <button
                  type="button"
                  key={period}
                  onClick={() => setDays(period)}
                  aria-pressed={days === period}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${days === period ? 'bg-indigo-500 text-white shadow-xs' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
                >
                  {period}일
                </button>
              ))}
            </div>
          </div>
          {query.isError && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4"
            >
              <p className="text-sm text-rose-300">통계를 불러오지 못했습니다.</p>
              <p className="mt-1 break-words text-xs text-zinc-400">
                {query.error instanceof Error ? query.error.message : '잠시 후 다시 시도해 주세요.'}
              </p>
              {stats && (
                <p className="mt-1 text-xs text-zinc-400">
                  마지막으로 불러온 통계를 표시하고 있습니다.
                </p>
              )}
              <button
                type="button"
                onClick={() => query.refetch()}
                disabled={query.isFetching}
                className="mt-3 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                다시 시도
              </button>
            </div>
          )}
          {query.isLoading && (
            <div role="status" className={`${cardClass} p-10 text-center text-sm text-zinc-400`}>
              통계를 불러오는 중입니다…
            </div>
          )}
          {stats && (
            <>
              {stats.totalVideos === 0 && (
                <EmptyMessage
                  title="아직 등록된 영상이 없습니다."
                  detail="라이브러리에 영상을 추가하면 구성 통계를 확인할 수 있습니다. 기존 시청 기록은 유지됩니다."
                />
              )}
              <div
                data-testid="stats-period-summary"
                className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
              >
                <StatCard
                  label="시청 시간"
                  value={formatTime(stats.period.watchedSec)}
                  accent
                  testId="period-watched"
                >
                  <Comparison
                    current={stats.period.watchedSec}
                    previous={stats.period.previousWatchedSec}
                    days={days}
                  />
                </StatCard>
                <StatCard label="재생 횟수" value={`${number(stats.period.sessionCount)}회`}>
                  <Comparison
                    current={stats.period.sessionCount}
                    previous={stats.period.previousSessionCount}
                    days={days}
                  />
                </StatCard>
                <StatCard label="시청한 영상" value={`${number(stats.period.uniqueVideos)}개`}>
                  중복을 제외한 영상 수
                </StatCard>
                <StatCard label="시청한 날" value={`${number(stats.period.activeDays)}일`}>
                  {days}일 중 기록이 있는 날
                </StatCard>
                <StatCard label="최장 연속 시청" value={`${number(stats.period.longestStreak)}일`}>
                  선택한 기간 안의 연속 기록
                </StatCard>
                <StatCard label="새로 추가한 영상" value={`${number(stats.period.addedVideos)}개`}>
                  선택한 기간에 등록한 보유 영상
                </StatCard>
              </div>
              <p className="mt-3 text-xs text-zinc-500">
                1회 평균 시청 {formatTime(stats.period.averageSessionSec)} · 시청 시간이 기록된
                재생만 집계합니다.
              </p>
              {stats.period.sessionCount === 0 ? (
                <div className="mt-4">
                  <EmptyMessage
                    title="이 기간에는 시청 기록이 없습니다."
                    detail="기간을 바꾸거나 영상을 재생하면 시청 패턴과 많이 본 영상을 확인할 수 있습니다."
                  />
                </div>
              ) : (
                <>
                  <div data-testid="stats-daily-chart" className={`${cardClass} mt-5 p-4 sm:p-5`}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-medium">일별 시청 기록</h3>
                        <p className="mt-1 text-xs text-zinc-500">매일의 시청 흐름</p>
                      </div>
                      <div role="group" aria-label="일별 차트 항목" className="flex gap-1">
                        {[
                          ['watchedSec', '시청 시간'],
                          ['sessionCount', '재생 횟수'],
                        ].map(([key, label]) => (
                          <button
                            type="button"
                            key={key}
                            onClick={() => setDailyMetric(key)}
                            aria-pressed={dailyMetric === key}
                            className={`rounded-md px-2.5 py-1.5 text-xs ${dailyMetric === key ? 'bg-indigo-500/15 text-indigo-300' : 'text-zinc-500 hover:text-zinc-200'}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <ActivityChart
                      data={stats.dailyStats}
                      dataKey={dailyMetric}
                      categoryKey="date"
                      tickFormatter={(date) => date.slice(5).replace('-', '/')}
                      labelFormatter={(date) => date}
                    />
                  </div>
                  <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
                    <div data-testid="stats-weekday-chart" className={`${cardClass} p-4 sm:p-5`}>
                      <h3 className="text-sm font-medium">요일별 시청 시간</h3>
                      <p className="mb-3 mt-1 text-xs text-zinc-500">선택한 기간의 요일별 합계</p>
                      <ActivityChart
                        data={[1, 2, 3, 4, 5, 6, 0].map(
                          (weekday) =>
                            stats.weekdayStats.find((row) => row.weekday === weekday) || {
                              weekday,
                              watchedSec: 0,
                              sessionCount: 0,
                            },
                        )}
                        dataKey="watchedSec"
                        categoryKey="weekday"
                        tickFormatter={(day) => WEEKDAYS[day]}
                        labelFormatter={(day) => `${WEEKDAYS[day]}요일`}
                        color="#38bdf8"
                        height={170}
                      />
                    </div>
                    <div data-testid="stats-hourly-chart" className={`${cardClass} p-4 sm:p-5`}>
                      <h3 className="text-sm font-medium">시간대별 시청 시간</h3>
                      <p className="mb-3 mt-1 text-xs text-zinc-500">재생을 시작한 시간대 기준</p>
                      <ActivityChart
                        data={stats.hourlyStats}
                        dataKey="watchedSec"
                        categoryKey="hour"
                        tickFormatter={(hour) => `${hour}시`}
                        labelFormatter={(hour) => `${hour}시 – ${hour + 1}시`}
                        color="#a78bfa"
                        height={170}
                      />
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </section>

        {stats && (
          <>
            <section data-testid="stats-library-summary" aria-labelledby="stats-library-heading">
              <SectionHeading
                id="stats-library-heading"
                title="라이브러리 현황"
                description="기간 선택과 무관한 현재 보유 현황과 누적 시청 기록입니다."
              />
              <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <StatCard label="전체 영상" value={`${number(stats.totalVideos)}개`}>
                  재생 이력이 있는 보유 영상 {number(stats.library.watchedVideos)}개
                </StatCard>
                <StatCard label="영상 총 길이" value={formatTime(stats.library.totalDurationSec)}>
                  {stats.library.durationUnknownVideos
                    ? `길이 미확인 ${number(stats.library.durationUnknownVideos)}개 제외`
                    : '등록된 영상 길이의 합계'}
                </StatCard>
                <StatCard label="영상 총 용량" value={formatBytes(stats.library.totalSizeBytes)}>
                  {stats.library.sizeUnknownVideos
                    ? `용량 미확인 ${number(stats.library.sizeUnknownVideos)}개 제외`
                    : '원본 영상의 등록된 파일 크기'}
                </StatCard>
                <StatCard label="누적 시청 시간" value={formatTime(stats.totalWatchedSec)}>
                  전체 기간 · 제거한 영상 기록 포함
                </StatCard>
                <StatCard
                  label="평균 별점"
                  value={
                    stats.library.ratedVideos ? `${stats.avgRating.toFixed(1)} / 5` : '아직 없음'
                  }
                >
                  별점을 준 영상 {number(stats.library.ratedVideos)}개
                </StatCard>
                <StatCard label="하이라이트" value={`${number(stats.library.highlightCount)}개`}>
                  {number(stats.library.highlightedVideos)}개 영상에 저장됨
                </StatCard>
              </div>
            </section>

            <section
              data-testid="stats-library-coverage"
              aria-labelledby="stats-coverage-heading"
              className={`${cardClass} p-4 sm:p-5`}
            >
              <SectionHeading
                id="stats-coverage-heading"
                title="라이브러리 관리 현황"
                description="영상 수 기준으로 자막과 정리 상태를 확인합니다."
              />
              <div className="grid min-w-0 gap-6 lg:grid-cols-2">
                <div className="min-w-0">
                  <CoverageRow
                    label="자막이 있는 영상"
                    count={stats.library.subtitleVideos}
                    total={stats.totalVideos}
                    color="bg-indigo-400"
                  />
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-lg bg-zinc-800/70 p-3">
                      <p className="text-xs text-zinc-400">한국어 자막</p>
                      <p className="mt-1 text-lg font-semibold">
                        {number(stats.library.koreanSubtitleVideos)}
                        <span className="ml-1 text-xs font-normal text-zinc-500">개</span>
                      </p>
                    </div>
                    <div className="rounded-lg bg-zinc-800/70 p-3">
                      <p className="text-xs text-zinc-400">AI 생성 자막</p>
                      <p className="mt-1 text-lg font-semibold">
                        {number(stats.library.generatedSubtitleVideos)}
                        <span className="ml-1 text-xs font-normal text-zinc-500">개</span>
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                    등록된 자막 목록 기준입니다. 한국어와 AI 생성 자막은 한 영상에 함께 있을 수
                    있습니다.
                  </p>
                </div>
                <div className="space-y-4">
                  <CoverageRow
                    label="재생 이력이 없는 영상"
                    count={stats.library.unwatchedVideos}
                    total={stats.totalVideos}
                    color="bg-sky-400"
                  />
                  <CoverageRow
                    label="별점을 준 영상"
                    count={stats.library.ratedVideos}
                    total={stats.totalVideos}
                    color="bg-amber-400"
                  />
                  <CoverageRow
                    label="하이라이트가 있는 영상"
                    count={stats.library.highlightedVideos}
                    total={stats.totalVideos}
                    color="bg-violet-400"
                  />
                  <CoverageRow
                    label="태그가 있는 영상"
                    count={stats.library.taggedVideos}
                    total={stats.totalVideos}
                    color="bg-teal-400"
                  />
                </div>
              </div>
            </section>

            <section aria-labelledby="stats-composition-heading" className="min-w-0">
              <SectionHeading
                id="stats-composition-heading"
                title="라이브러리 구성"
                description="어떤 영상을 얼마나 보유하고 있는지 한눈에 확인하세요."
              />
              <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <DistributionCard
                  kind="resolutions"
                  title="해상도"
                  rows={stats.distributions.resolutions}
                  total={stats.totalVideos}
                  color="bg-indigo-400"
                  note="가로·세로 중 짧은 변 기준"
                />
                <DistributionCard
                  kind="durations"
                  title="영상 길이"
                  rows={stats.distributions.durations}
                  total={stats.totalVideos}
                  color="bg-sky-400"
                />
                <DistributionCard
                  kind="formats"
                  title="파일 형식"
                  rows={stats.distributions.formats}
                  total={stats.totalVideos}
                  color="bg-violet-400"
                />
                <DistributionCard
                  kind="ratings"
                  title="별점 분포"
                  rows={stats.distributions.ratings}
                  total={stats.totalVideos}
                  color="bg-amber-400"
                />
              </div>
            </section>

            <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <section
                data-testid="stats-top-videos"
                className={`${cardClass} p-4 sm:p-5`}
                aria-labelledby="stats-top-heading"
              >
                <SectionHeading
                  id="stats-top-heading"
                  title="현재 보유 영상 Top 10"
                  description={`최근 ${days}일 · 많이 본 영상 · 시청 시간 순`}
                />
                {stats.topVideos.length ? (
                  <ol className="space-y-1">
                    {stats.topVideos.map((video, index) => (
                      <li
                        key={video.id}
                        className="flex min-w-0 items-center gap-3 rounded-lg py-2.5"
                      >
                        <span
                          className={`w-5 shrink-0 text-center text-sm font-semibold ${index < 3 ? 'text-indigo-300' : 'text-zinc-600'}`}
                        >
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p
                            title={video.title || video.fileName}
                            className="truncate text-sm text-zinc-200"
                          >
                            {video.title || video.fileName}
                          </p>
                          {video.title && video.title !== video.fileName && (
                            <p
                              title={video.fileName}
                              className="mt-0.5 truncate text-xs text-zinc-500"
                            >
                              {video.fileName}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-zinc-500">
                            {formatTime(video.watchedSec)} <span className="mx-1">·</span>{' '}
                            {number(video.sessionCount)}회 재생
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => navigate(`/player/${activeLibraryId}/${video.id}`)}
                          aria-label={`${video.title || video.fileName} 재생`}
                          className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:border-indigo-400/60 hover:bg-indigo-500/10 hover:text-indigo-200"
                        >
                          재생
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="py-8 text-center text-sm text-zinc-500">
                    선택한 기간에 시청한 보유 영상이 없습니다.
                  </p>
                )}
              </section>
              <DistributionCard
                kind="tags"
                title="많이 사용한 태그"
                rows={stats.distributions.tags}
                total={stats.totalVideos}
                color="bg-teal-400"
                note="상위 10개 · 한 영상에 여러 태그가 포함될 수 있습니다."
              />
            </div>
            <footer className="border-t border-zinc-800 pt-4 text-xs leading-relaxed text-zinc-500">
              시청 통계는 이 프로그램에 기록된 재생 시간을 사용하며, 날짜·요일·시간대는 컴퓨터의
              현지 재생 시작 시각을 기준으로 집계합니다. 시청 기록에는 목록에서 제거한 영상도
              포함됩니다. 보유 현황과 순위는 현재 목록 기준입니다. 시청 시간으로 영상 완주 여부를
              판단하지 않습니다.
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

function SectionHeading({ id, title, description }) {
  return (
    <div className="mb-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {description && <p className="mt-1 text-xs leading-relaxed text-zinc-500">{description}</p>}
    </div>
  )
}

function EmptyMessage({ title, detail }) {
  return (
    <div className="mb-4 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 px-5 py-6 text-center">
      <p className="text-sm text-zinc-300">{title}</p>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">{detail}</p>
    </div>
  )
}

function StatCard({ label, value, children, accent = false, testId }) {
  return (
    <div className={`${cardClass} p-4 ${accent ? 'border-indigo-500/30 bg-indigo-500/5' : ''}`}>
      <p className="text-xs text-zinc-400">{label}</p>
      <p
        data-testid={testId}
        className={`mt-2 break-words text-xl font-semibold tracking-tight sm:text-2xl ${accent ? 'text-indigo-200' : 'text-white'}`}
      >
        {value}
      </p>
      <div className="mt-2 text-xs leading-relaxed text-zinc-500">{children}</div>
    </div>
  )
}

function Comparison({ current, previous, days }) {
  if (!previous)
    return (
      <span>
        이전 {days}일 {current ? '기록 없음' : '대비 변화 없음'}
      </span>
    )
  const change = Math.round(((current - previous) / previous) * 100)
  return (
    <span>
      이전 {days}일 대비{' '}
      <span className={change ? 'text-indigo-300' : ''}>
        {change > 0 ? '↑ ' : change < 0 ? '↓ ' : ''}
        {number(Math.abs(change))}%
      </span>
    </span>
  )
}

function CoverageRow({ label, count, total, color }) {
  const percent = percentage(count, total)
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 break-words text-zinc-300">{label}</span>
        <span className="shrink-0 tabular-nums text-zinc-400">
          {number(count)}개 <span className="ml-1 text-zinc-500">{percent}%</span>
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total || 1}
        aria-valuenow={count}
        aria-valuetext={`${number(count)}개, ${percent}%`}
        className="h-1.5 overflow-hidden rounded-full bg-zinc-800"
      >
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  )
}

function DistributionCard({ kind, title, rows, total, color, note }) {
  return (
    <section
      data-testid={`stats-distribution-${kind}`}
      className={`${cardClass} p-4 sm:p-5`}
      aria-label={title}
    >
      <h3 className="text-sm font-medium">{title}</h3>
      {note && <p className="mt-1 text-xs leading-relaxed text-zinc-500">{note}</p>}
      {rows.some((row) => row.count > 0) ? (
        <div className="mt-5 space-y-4">
          {rows.map((row) => (
            <CoverageRow
              key={row.key}
              label={row.label}
              count={row.count}
              total={total}
              color={color}
            />
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-xs text-zinc-500">
          {kind === 'tags' ? '아직 등록된 태그가 없습니다.' : '집계할 영상이 없습니다.'}
        </p>
      )}
    </section>
  )
}

function ActivityChart({
  data,
  dataKey,
  categoryKey,
  tickFormatter,
  labelFormatter,
  color = '#818cf8',
  height = 225,
}) {
  const isTime = dataKey === 'watchedSec'
  return (
    <div className="min-w-0 w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }} accessibilityLayer>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey={categoryKey}
            tickFormatter={tickFormatter}
            tick={{ fill: '#a1a1aa', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: '#a1a1aa', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={56}
            allowDecimals={isTime}
            tickFormatter={(value) =>
              isTime
                ? value >= 3600
                  ? `${Math.round(value / 360) / 10}시간`
                  : `${Math.round(value / 6) / 10}분`
                : `${value}회`
            }
          />
          <Tooltip
            cursor={{ fill: '#ffffff06' }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = payload[0].payload
              return (
                <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs shadow-xl">
                  <p className="mb-1 text-zinc-400">{labelFormatter(label)}</p>
                  <p className="text-zinc-100">시청 시간 {formatTime(row.watchedSec)}</p>
                  <p className="mt-1 text-zinc-400">
                    {number(row.sessionCount)}회 재생
                    {row.videoCount !== undefined ? ` · ${number(row.videoCount)}개 영상` : ''}
                  </p>
                </div>
              )
            }}
          />
          <Bar
            dataKey={dataKey}
            name={isTime ? '시청 시간' : '재생 횟수'}
            fill={color}
            radius={[3, 3, 0, 0]}
            maxBarSize={38}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function formatTime(value) {
  const sec = Math.max(0, Math.round(value || 0))
  if (sec < 60) return `${number(sec)}초`
  if (sec < 3600) return `${number(Math.floor(sec / 60))}분${sec % 60 ? ` ${sec % 60}초` : ''}`
  return `${number(Math.floor(sec / 3600))}시간${Math.floor((sec % 3600) / 60) ? ` ${Math.floor((sec % 3600) / 60)}분` : ''}`
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${number(Math.round((bytes / 1024 ** index) * 10) / 10)} ${units[index]}`
}

export default StatsPage
