// Real statistics IPC and dashboard, using only an isolated temporary SQLite library.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const code = executablePath
  ? require('@electron/asar')
      .extractFile(
        path.join(path.dirname(executablePath), 'resources/app.asar'),
        path.join('out', 'main', 'index.js'),
      )
      .toString('utf8')
  : fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8')
assert.ok(code.includes('DVM_USER_DATA_DIR') && code.includes('DVM_SMOKE_TEST'))
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-stats-'))
const userData = path.join(temporary, 'user-data')
const media = path.join(temporary, 'media')
fs.mkdirSync(media)
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true })
const passed = []
const pageErrors = []
const seed = `
const path = require('node:path');
const Database = require('better-sqlite3');
const dbPath = path.resolve(process.argv[1]);
const allowed = path.resolve(process.argv[2]) + path.sep;
if (!dbPath.startsWith(allowed)) throw new Error('Seed escaped isolated user data');
const db = new Database(dbPath, {fileMustExist: true});
const now = new Date();
const date = (offset) => { const d = new Date(now); d.setDate(d.getDate()+offset); d.setHours(0,0,0,0); return d.toISOString(); };
const addVideo = db.prepare('INSERT INTO videos (id,file_path,file_name,title,duration_sec,width,height,size_bytes,rating,tags,created_at,removal_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const addHistory = db.prepare('INSERT INTO play_history (id,video_id,started_at,duration_watched_sec) VALUES (?,?,?,?)');
db.transaction(() => {
  addVideo.run('one',path.join(process.argv[3],'one.mp4'),'one.mp4','First synthetic video',1200,1920,1080,10485760,5,'travel, test',date(-1),null);
  addVideo.run('two',path.join(process.argv[3],'two.mp4'),'two.mp4','Second synthetic video',3600,720,1280,20971520,3,'travel',date(-8),null);
  addVideo.run('three',path.join(process.argv[3],'three.mkv'),'three.mkv','Unwatched synthetic video',null,null,null,null,0,'',date(-20),null);
  addVideo.run('removed',path.join(process.argv[3],'removed.mp4'),'removed.mp4','Removed synthetic video',600,640,480,1024,1,'removed',date(-1),'remove');
  addHistory.run('today','one',date(0),150);
  addHistory.run('recent','one',date(-2),60);
  addHistory.run('previous','two',date(-8),180);
  addHistory.run('older','two',date(-12),600);
  addHistory.run('removed-history','removed',date(-1),40);
  addHistory.run('future','one',date(1),999);
  addHistory.run('empty','three',date(0),0);
  db.prepare('INSERT INTO subtitles (id,video_id,file_path,lang,type) VALUES (?,?,?,?,?)').run('subtitle','one',path.join(process.argv[3],'one.ai.ko.srt'),'ko','srt');
  db.prepare('INSERT INTO highlights (id,video_id,time_start,label,color) VALUES (?,?,?,?,?)').run('highlight','one',5,'Synthetic highlight','yellow');
})()
db.close();
`
async function until(label, predicate) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
async function main() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DVM_USER_DATA_DIR: userData,
    DVM_SMOKE_TEST: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60000,
  })
  let failure
  try {
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), userData)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
    })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await until('preload ready', () => page.evaluate(() => !!window.api?.stats))
    const invoke = async (group, method, ...args) => {
      const result = await page.evaluate(
        async ({ group, method, args }) => window.api[group][method](...args),
        { group, method, args },
      )
      assert.equal(result.ok, true, `${group}.${method}: ${result.error}`)
      return result.value
    }
    const library = await invoke('library', 'create', 'Statistics smoke library', media)
    await invoke('library', 'open', library.id)
    const empty = await invoke('stats', 'get', library.id, 7)
    assert.equal(empty.totalVideos, 0)
    assert.equal(empty.dailyStats.length, 7)
    assert.equal(empty.period.watchedSec, 0)
    passed.push('empty real library returns complete zero-filled statistics')
    execFileSync(require('electron'), ['-e', seed, library.dbPath, userData, media], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    })
    const week = await invoke('stats', 'get', library.id, 7)
    assert.equal(week.totalVideos, 3)
    assert.equal(week.totalWatchedSec, 1030)
    assert.equal(week.period.watchedSec, 250)
    assert.equal(week.period.previousWatchedSec, 780)
    assert.equal(week.period.sessionCount, 3)
    assert.equal(week.dailyStats.length, 7)
    assert.equal(week.hourlyStats.length, 24)
    assert.equal(week.weekdayStats.length, 7)
    assert.deepEqual(
      week.topVideos.map((v) => v.id),
      ['one'],
    )
    assert.equal(week.library.subtitleVideos, 1)
    assert.equal(week.library.koreanSubtitleVideos, 1)
    assert.equal(week.library.generatedSubtitleVideos, 1)
    assert.equal(week.library.highlightCount, 1)
    passed.push(
      'real SQL aggregates respect period, prior period, removed history, subtitles, and future exclusion',
    )
    const month = await invoke('stats', 'get', library.id, 30)
    assert.equal(month.period.watchedSec, 1030)
    assert.deepEqual(
      month.topVideos.map((v) => v.id),
      ['two', 'one'],
    )
    const year = await invoke('stats', 'get', library.id, 365)
    assert.equal(year.dailyStats.length, 365)
    const invalid = await page.evaluate((id) => window.api.stats.get(id, 366), library.id)
    assert.equal(invalid.ok, false)
    passed.push('period changes update rankings; one-year range is bounded by IPC validation')
    await page.reload()
    await page.getByRole('button', { name: '열기', exact: true }).click()
    await page.getByRole('link', { name: '통계', exact: true }).click()
    await page.getByTestId('stats-dashboard').waitFor({ state: 'visible' })
    await until('month rendered', () =>
      page
        .getByTestId('period-watched')
        .innerText()
        .then((text) => text.includes('17분')),
    )
    await page.getByRole('button', { name: '7일', exact: true }).click()
    await until('week rendered', () =>
      page
        .getByTestId('period-watched')
        .innerText()
        .then((text) => text.includes('4분')),
    )
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 600),
    )
    await until('window resized', () => page.evaluate(() => innerWidth === 900))
    await until('chart resize settled', () =>
      page
        .getByTestId('stats-page')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    )
    const layout = await page.getByTestId('stats-page').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout))
    assert.ok(
      layout.scrollHeight > layout.clientHeight,
      'Dashboard must scroll to its lower panels',
    )
    assert.deepEqual(pageErrors, [])
    passed.push(
      'packaged dashboard renders real values, switches periods, and scrolls without horizontal overflow',
    )
  } catch (error) {
    failure = error
    throw error
  } finally {
    const report = {
      passed,
      temporary,
      packaged: !!executablePath,
      pageErrors,
      ...(failure ? { error: String(failure.stack || failure) } : {}),
    }
    fs.writeFileSync(
      path.join(
        root,
        'test-results',
        executablePath ? 'stats-packaged.json' : 'stats-electron.json',
      ),
      JSON.stringify(report, null, 2),
    )
    await app.close()
    if (!failure) console.log(JSON.stringify(report, null, 2))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
