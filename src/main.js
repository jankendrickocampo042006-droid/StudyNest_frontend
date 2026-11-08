import './style.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { apiBase, apiRequest } from './api.js';
import AuthApp from './AuthApp.jsx';

let subjects = [];
let lessons = [];
let quizzes = [];
let quizQuestions = [];
let topics = [];
let management = { subjects: [], topics: [], lessons: [], quizzes: [] };
let teachers = [];
let teacherApplications = [];
let students = [];
let privateLibrary = [];

let state = {
  user: null,
  sets: [],
  schedules: [],
  favorites: [],
  favoriteSubjects: [],
  reviewedLessons: [],
  attempts: [],
  activities: [],
  studyTimeSeconds: 0,
  weakTopics: [],
  weeklyStudy: [],
  certificates: [],
  notifications: [],
  readNotificationIds: [],
  notificationPreferences: {
    email_certificates: true,
    email_content_updates: true,
  },
  quizResult: null,
  activeLessonId: null,
  activePdfLessonId: null,
  activePdfUrl: null,
  pdfLoadingLessonId: null,
  pdfErrorMessage: '',
  lessonStartedAt: 0,
};

const lessonReviewRequests = new Set();
const viewedPdfSyncRequests = new Set();
let quizSession = null;
let quizTimerInterval = null;
let flashcardSession = null;
let lessonSpeech = { lessonId: null, status: 'idle', utterance: null };
let toastTimer;
let loadingTimer = null;
let pendingLoadingActions = 0;
let loadingIndicator = null;
const app = document.querySelector('#app');
let authRoot = null;
let initialSessionRequest = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function route() {
  return location.hash.replace(/^#\/?/, '') || (state.user ? 'dashboard' : 'login');
}

function go(path) {
  location.hash = `/${path}`;
}

function updateLessonSpeechControls() {
  const supported = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
  const currentLessonId = Number(route().match(/(?:^|\/)lesson\/(\d+)/)?.[1]);
  const isCurrentLesson = currentLessonId && lessonSpeech.lessonId === currentLessonId;
  const status = isCurrentLesson ? lessonSpeech.status : 'idle';
  const playButton = document.querySelector('[data-action="read-lesson"]');
  const toggleButton = document.querySelector('[data-action="toggle-lesson-speech"]');
  const stopButton = document.querySelector('[data-action="stop-lesson-speech"]');
  const statusLabel = document.querySelector('#lesson-speech-status');

  if (playButton) playButton.disabled = !supported || status === 'speaking';
  if (toggleButton) {
    toggleButton.disabled = !supported || status === 'idle';
    toggleButton.textContent = status === 'paused' ? 'Continue' : 'Pause';
  }
  if (stopButton) stopButton.disabled = !supported || status === 'idle';
  if (statusLabel) {
    statusLabel.textContent = !supported
      ? 'Text-to-speech is not supported by this browser.'
      : status === 'speaking' ? 'Reading lesson…'
        : status === 'paused' ? 'Reading paused.'
          : 'Listen to the lesson using your device’s available voice.';
  }
}

function stopLessonSpeech() {
  if (lessonSpeech.utterance && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  lessonSpeech = { lessonId: null, status: 'idle', utterance: null };
  updateLessonSpeechControls();
}

function readLessonAloud(lesson) {
  if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') {
    notify('Text-to-speech is not supported by this browser.');
    return;
  }
  stopLessonSpeech();
  const utterance = new window.SpeechSynthesisUtterance(`${lesson.title}. ${lesson.content}`);
  utterance.onend = () => {
    if (lessonSpeech.utterance !== utterance) return;
    lessonSpeech = { lessonId: null, status: 'idle', utterance: null };
    updateLessonSpeechControls();
  };
  utterance.onerror = (event) => {
    if (lessonSpeech.utterance !== utterance) return;
    lessonSpeech = { lessonId: null, status: 'idle', utterance: null };
    updateLessonSpeechControls();
    if (!['canceled', 'interrupted'].includes(event.error)) {
      notify('Could not read this lesson aloud. Try again or check your device audio settings.');
    }
  };
  lessonSpeech = { lessonId: lesson.id, status: 'speaking', utterance };
  updateLessonSpeechControls();
  window.speechSynthesis.speak(utterance);
}

function notify(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function showLoadingIndicator() {
  if (!loadingIndicator) {
    loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'loading-overlay';
    loadingIndicator.setAttribute('role', 'status');
    loadingIndicator.setAttribute('aria-live', 'polite');
    loadingIndicator.innerHTML = '<div class="loading-card"><div class="loading-brand"><span class="loading-brand-mark">s</span><span><b>StudyNest</b><small>YOUR LEARNING SPACE</small></span></div><div class="loading-orbit" aria-hidden="true"><span></span><i></i><b></b></div><strong>Getting things ready</strong><p>We’re loading your learning space.</p><div class="loading-progress" aria-hidden="true"><span></span></div></div>';
    document.body.append(loadingIndicator);
  }
  loadingIndicator.classList.add('is-visible');
}

function beginLoading() {
  pendingLoadingActions += 1;
  if (pendingLoadingActions === 1) {
    loadingTimer = setTimeout(showLoadingIndicator, 100);
  }
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pendingLoadingActions = Math.max(0, pendingLoadingActions - 1);
    if (pendingLoadingActions) return;
    clearTimeout(loadingTimer);
    loadingTimer = null;
    loadingIndicator?.classList.remove('is-visible');
  };
}

async function withLoading(task) {
  const finishLoading = beginLoading();
  try {
    return await task();
  } finally {
    finishLoading();
  }
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((value) => {
    let cell = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportDate() {
  return new Date().toISOString().slice(0, 10);
}

function downloadReport(report, kind = '') {
  const generated = new Date().toISOString();
  let rows;
  let filename;
  if (report === 'progress') {
    const averageScore = state.attempts.length
      ? Math.round(state.attempts.reduce((total, attempt) => total + Number(attempt.score), 0) / state.attempts.length)
      : 0;
    rows = [
      ['Section', 'Date', 'Subject', 'Metric', 'Value'],
      ['Summary', generated, '', 'Student', state.user?.name || ''],
      ['Summary', generated, '', 'Email', state.user?.email || ''],
      ['Summary', generated, '', 'Study time (seconds)', state.studyTimeSeconds],
      ['Summary', generated, '', 'Lessons reviewed', state.reviewedLessons.length],
      ['Summary', generated, '', 'Quizzes completed', state.attempts.length],
      ['Summary', generated, '', 'Average quiz score (%)', averageScore],
      ...subjects.map((subject) => ['Subject', generated, subject.name, 'Lesson completion (%)', subject.progress]),
      ...subjects.map((subject) => ['Subject', generated, subject.name, 'Lessons available', subject.lessons]),
      ...state.weeklyStudy.map((day) => ['Daily study', day.study_date, '', 'Study time (seconds)', day.duration_seconds]),
    ];
    filename = `studynest-progress-${reportDate()}.csv`;
  } else if (report === 'history') {
    rows = [
      ['Quiz', 'Subject', 'Score (%)', 'Completed at'],
      ...state.attempts.map((attempt) => [attempt.title, attempt.subject, attempt.score, new Date(attempt.date).toISOString()]),
    ];
    filename = `studynest-quiz-history-${reportDate()}.csv`;
  } else if (report === 'students') {
    rows = [
      ['Name', 'Email', 'Account status', 'Joined'],
      ...students.map((student) => [
        student.name,
        student.email,
        Number(student.is_active) === 1 && student.email_verified_at ? 'Active' : 'Inactive or unverified',
        student.created_at,
      ]),
    ];
    filename = `studynest-students-${reportDate()}.csv`;
  } else if (report === 'teachers') {
    rows = [
      ['Name', 'Email', 'Teacher ID', 'Joined'],
      ...teachers.map((teacher) => [teacher.name, teacher.email, teacher.teacher_id || '', teacher.created_at || '']),
    ];
    filename = `studynest-teachers-${reportDate()}.csv`;
  } else if (report === 'catalog' && ['subjects', 'topics', 'lessons', 'quizzes'].includes(kind)) {
    const entries = management[kind] || [];
    rows = [
      ['Type', 'Name', 'Subject', 'Topic', 'Description or lesson content', 'Duration (minutes)', 'Question count', 'PDF filename', 'PDF download URL'],
      ...entries.map((entry) => {
        const name = entry.name || entry.title || '';
        const pdfUrl = kind === 'lessons' && entry.pdf_original_name
          ? `${apiBase}/api/lessons/${encodeURIComponent(entry.id)}/pdf?download=1`
          : '';
        return [
          ({ subjects: 'Subject', topics: 'Topic', lessons: 'Lesson', quizzes: 'Quiz' })[kind],
          name,
          entry.subject || '',
          entry.topic || '',
          kind === 'subjects' ? entry.description || '' : kind === 'lessons' ? entry.content || '' : '',
          kind === 'quizzes' ? entry.time || '' : '',
          kind === 'quizzes' ? (entry.questions || []).length : '',
          entry.pdf_original_name || '',
          pdfUrl,
        ];
      }),
    ];
    filename = `studynest-${kind}-${reportDate()}.csv`;
  } else {
    notify('This report is not available.');
    return;
  }
  downloadCsv(filename, rows);
  notify('Your CSV report has been downloaded.');
}

function save(key, value) {
  state[key] = value;
}

function canManageContent(role = state.user?.role) {
  return ['admin', 'moderator', 'teacher'].includes(role);
}

function notificationStorageKey(user = state.user) {
  const identity = user?.id ?? user?.email;
  return identity ? `studynest-read-notifications-${identity}` : '';
}

function storeReadNotifications() {
  const key = notificationStorageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(state.readNotificationIds));
  } catch {
    notify('Your notification read status could not be saved on this device.');
  }
}

function unreadNotificationCount() {
  return state.notifications.filter((item) => !item.isRead && !state.readNotificationIds.includes(item.id)).length;
}

async function markNotificationAsRead(id) {
  const notification = state.notifications.find((item) => item.id === id);
  if (!notification || notification.isRead || state.readNotificationIds.includes(id)) return;
  if (notification.backendId) {
    const result = await apiCall(`/notifications/${notification.backendId}`, { method: 'PUT', body: JSON.stringify({}) });
    if (!result) return;
    notification.isRead = true;
  } else {
    state.readNotificationIds = [...state.readNotificationIds, id];
    storeReadNotifications();
  }
  render();
}

async function markAllNotificationsAsRead() {
  const unreadServerNotifications = state.notifications.filter((item) => item.backendId && !item.isRead);
  if (unreadServerNotifications.length) {
    const result = await apiCall('/notifications/read-all', { method: 'POST', body: JSON.stringify({}) });
    if (!result) return;
    unreadServerNotifications.forEach((item) => { item.isRead = true; });
  }
  const unreadIds = state.notifications
    .filter((item) => !item.backendId && !item.isRead && !state.readNotificationIds.includes(item.id))
    .map((item) => item.id);
  if (unreadIds.length) {
    state.readNotificationIds = [...new Set([...state.readNotificationIds, ...unreadIds])];
    storeReadNotifications();
  }
  render();
}

function mergeStoredNotifications(items) {
  const savedNotifications = items.map((item) => ({
    id: `server:${item.id}`,
    backendId: Number(item.id),
    date: new Date(item.created_at),
    title: item.title,
    detail: item.message,
    tone: item.type === 'certificate_earned' ? 'mint' : 'lavender',
    isRead: Boolean(item.read_at),
    link: item.link || '',
  }));
  state.notifications = [
    ...savedNotifications,
    ...state.notifications.filter((item) => !item.backendId),
  ].sort((a, b) => b.date - a.date);
}

async function refreshStoredNotifications() {
  const notifications = await apiCall('/notifications');
  if (!Array.isArray(notifications)) return false;
  mergeStoredNotifications(notifications);
  return true;
}

function releaseLessonPdf() {
  if (state.activePdfUrl) URL.revokeObjectURL(state.activePdfUrl);
  state.activePdfUrl = null;
}

async function apiCall(path, options = {}) {
  const finishLoading = beginLoading();
  try {
    if ((options.method || 'GET').toUpperCase() !== 'GET' && initialSessionRequest) {
      await initialSessionRequest;
    }
    return await apiRequest(path, options);
  } catch (error) {
    if (error instanceof Error && error.payload?.requires_email_verification) {
      sessionStorage.setItem('studynest_pending_email', error.payload.email);
      save('user', null);
      go('verify-email');
      render();
    }
    notify(error instanceof Error ? error.message : 'StudyNest could not complete that request.');
    return null;
  } finally {
    finishLoading();
  }
}

async function refreshCertificates(showNewCertificate = false) {
  const certificates = await apiCall('/certificates');
  if (!Array.isArray(certificates)) return false;
  const previousIds = new Set(state.certificates.map((certificate) => String(certificate.id)));
  state.certificates = certificates.map((certificate) => ({ ...certificate, id: Number(certificate.id) }));
  if (showNewCertificate) {
    const earned = state.certificates.find((certificate) => !previousIds.has(String(certificate.id)));
    if (earned) notify(`Congratulations! You earned a certificate for ${earned.subject_name}. View it in your profile.`);
    await refreshStoredNotifications();
  }
  return true;
}

async function markLessonAsRead(lessonId) {
  if (lessonReviewRequests.has(lessonId) || state.reviewedLessons.includes(lessonId)) return;
  lessonReviewRequests.add(lessonId);
  const duration = state.lessonStartedAt ? Math.min(7200, Math.floor((Date.now() - state.lessonStartedAt) / 1000)) : 0;
  const result = await apiCall(`/lessons/${lessonId}/review`, {
    method: 'POST',
    body: JSON.stringify({ duration_seconds: duration }),
  });
  lessonReviewRequests.delete(lessonId);
  if (!result) return;

  const lesson = lessons.find((item) => item.id === lessonId);
  if (lesson && !state.reviewedLessons.includes(lessonId)) {
    state.reviewedLessons = [...state.reviewedLessons, lessonId];
    const now = new Date();
    state.activities = [{
      type: 'lesson_reviewed',
      title: lesson.title,
      details: lesson.subject,
      created_at: now.toISOString(),
      date: now,
    }, ...state.activities].slice(0, 30);
  }
  await refreshCertificates(true);
  render();
}

async function markPdfLessonAsRead(lessonId) {
  if (viewedPdfSyncRequests.has(lessonId) || state.reviewedLessons.includes(lessonId)) return;
  viewedPdfSyncRequests.add(lessonId);
  try {
    const result = await apiCall(`/lessons/${lessonId}/viewed`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!result) return;
    state.reviewedLessons = [...state.reviewedLessons, lessonId];
    const lesson = lessons.find((item) => item.id === lessonId);
    if (lesson) {
      const now = new Date();
      state.activities = [{
        type: 'lesson_reviewed',
        title: lesson.title,
        details: lesson.subject,
        created_at: now.toISOString(),
        date: now,
      }, ...state.activities].slice(0, 30);
    }
    const status = document.querySelector(`[data-lesson-read-status="${lessonId}"]`);
    if (status) {
      status.textContent = 'Marked as read';
      status.classList.add('is-read');
    }
    await refreshCertificates(true);
    notify('Lesson marked as read.');
  } finally {
    viewedPdfSyncRequests.delete(lessonId);
  }
}

async function restoreInitialSession() {
  initialSessionRequest = (async () => {
    const session = await apiCall('/auth/session');
    if (!session?.authenticated || route() !== 'login') return;
    await loadBackendState();
  })();
  try {
    await initialSessionRequest;
  } finally {
    initialSessionRequest = null;
  }
}

async function loadBackendState() {
  const data = await apiCall('/bootstrap');
  if (!data) return false;
  const tones = ['mint', 'peach', 'lavender', 'sky'];
  const glyphs = ['⌁', '▦', '⌘', '✳'];
  subjects = data.subjects.map((subject, index) => ({
    ...subject,
    id: Number(subject.id),
    color: tones[index % tones.length],
    icon: glyphs[index % glyphs.length],
  }));
  lessons = data.lessons.map((lesson) => ({
    ...lesson,
    id: Number(lesson.id),
    topic_id: Number(lesson.topic_id),
    read: `${Math.max(1, Math.ceil(String(lesson.content || '').split(/\s+/).filter(Boolean).length / 200))} min read`,
  }));
  quizzes = data.quizzes.map((quiz) => ({
    ...quiz,
    id: Number(quiz.id),
    topic_id: Number(quiz.topic_id),
  }));
  topics = data.topics.map((topic) => ({
    ...topic,
    id: Number(topic.id),
    subject_id: Number(topic.subject_id),
    subject: subjects.find((subject) => Number(subject.id) === Number(topic.subject_id))?.name || '',
  }));
  state.user = data.user;
  const notificationKey = notificationStorageKey(state.user);
  try {
    const savedReadIds = notificationKey ? JSON.parse(localStorage.getItem(notificationKey) || '[]') : [];
    state.readNotificationIds = Array.isArray(savedReadIds) ? savedReadIds.filter((id) => typeof id === 'string') : [];
  } catch {
    state.readNotificationIds = [];
  }
  state.certificates = [];
  if (state.user?.role === 'user') await refreshCertificates();
  state.sets = data.sets.map((set) => ({ ...set, id: String(set.id), cards: set.cards || [] }));
  privateLibrary = data.user ? await apiCall('/my-library') || [] : [];
  state.schedules = data.schedules.map((item) => ({ ...item, id: String(item.id), time: item.time.slice(0, 5) }));
  state.favorites = data.favorites.map(Number);
  state.favoriteSubjects = (data.favoriteSubjects || []).map(Number);
  state.reviewedLessons = data.reviewedLessons.map(Number);
  state.attempts = data.attempts.map((attempt) => ({
    ...attempt,
    score: Number(attempt.score),
    date: attempt.date,
  }));
  state.activities = data.activities.map((item) => ({ ...item, date: new Date(item.created_at) }));
  state.studyTimeSeconds = Number(data.studyTimeSeconds || 0);
  state.weeklyStudy = data.weeklyStudy;
  state.weakTopics = data.weakTopics;
  state.notifications = [
    ...state.schedules.filter((item) => new Date(`${item.date}T${item.time}`) >= new Date()).map((item) => ({
      id: `schedule:${item.id}`,
      date: new Date(`${item.date}T${item.time}`),
      title: item.title,
      detail: `${item.date} · ${item.time}`,
      tone: 'mint',
    })),
    ...state.attempts.slice(0, 3).map((item) => ({
      id: `quiz:${item.id ?? `${item.date}:${item.title}:${item.subject}`}`,
      date: new Date(item.date),
      title: `Quiz completed: ${item.title}`,
      detail: `${item.subject} · ${item.score}%`,
      tone: 'peach',
    })),
  ].sort((a, b) => b.date - a.date);
  const [notificationsLoaded, notificationPreferences] = await Promise.all([
    refreshStoredNotifications(),
    apiCall('/notification-preferences'),
  ]);
  if (!notificationsLoaded) state.notifications = state.notifications.filter((item) => !item.backendId);
  if (notificationPreferences) {
    state.notificationPreferences = {
      email_certificates: Boolean(notificationPreferences.email_certificates),
      email_content_updates: Boolean(notificationPreferences.email_content_updates),
    };
  }
  const isAdmin = canManageContent();
  let currentRoute = route();
  if (state.user?.role === 'teacher_pending' && currentRoute !== 'teacher-application') {
    go('teacher-application');
    return true;
  }
  if (state.user && ['login', 'register', 'google-auth'].includes(currentRoute)) {
    currentRoute = isAdmin ? 'manage-content' : 'dashboard';
    go(currentRoute);
  }
  const managementRoute = currentRoute === 'manage-content' || currentRoute.startsWith('manage-');
  if (isAdmin && data.management) {
    management = data.management;
    teachers = data.teachers || [];
    teacherApplications = data.teacherApplications || [];
    students = data.students || [];
    if (state.user?.role === 'admin') {
      const applications = await apiCall('/manage/teacher-applications');
      if (!Array.isArray(applications)) return false;
      teacherApplications = applications;
    }
  } else if (isAdmin && currentRoute !== 'profile') {
    const [content, teacherList, applications] = await Promise.all([
      apiCall('/manage'),
      state.user?.role === 'admin' ? apiCall('/manage/teachers') : Promise.resolve([]),
      state.user?.role === 'admin' ? apiCall('/manage/teacher-applications') : Promise.resolve([]),
    ]);
    if (!content) return false;
    management = content;
    if (!Array.isArray(teacherList) || !Array.isArray(applications)) return false;
    teachers = teacherList;
    teacherApplications = applications;
    students = [];
  } else {
    management = { subjects: [], topics: [], lessons: [], quizzes: [] };
    teachers = [];
    teacherApplications = [];
    students = [];
  }
  if (isAdmin && !managementRoute && currentRoute !== 'profile') {
    go('manage-content');
    return true;
  }
  if (!isAdmin && managementRoute) {
    go('dashboard');
    return true;
  }
  render();
  return true;
}

async function refreshManagementState() {
  const content = await apiCall('/manage');
  if (!content) return false;
  management = content;
  render();
  return true;
}

function icon(name) {
  const paths = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7H10v7H4a1 1 0 0 1-1-1z"/>',
    chart: '<path d="M4 19V5m0 14h17M8 15l3-4 3 2 5-7"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21zm0 0V21"/>',
    cards: '<path d="M5 7h14v14H5zM8 4h13v14M8 10h8m-8 4h8"/>',
    quiz: '<path d="M5 4h14v17H5zM8 8h8m-8 4h8m-8 4h5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    heart: '<path d="M20.8 8.8c0 5.2-8.8 10.2-8.8 10.2S3.2 14 3.2 8.8A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 8.8 1.8Z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12h4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2Z"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.book}</svg>`;
}

function navItem(label, href, glyph, current) {
  return `<a class="nav-item ${current === href ? 'active' : ''}" href="#/${href}">${icon(glyph)}<span>${label}</span></a>`;
}

function adminNavItem(label, href, glyph, current, count = null) {
  return `<a class="nav-item admin-nav-item ${current === href ? 'active' : ''}" href="#/${href}">${icon(glyph)}<span>${label}</span>${count === null ? '' : `<small class="admin-nav-count">${count}</small>`}</a>`;
}

function shell(content, title, active) {
  const name = state.user?.name || '';
  const isAdmin = canManageContent();
  const adminRole = state.user?.role === 'admin';
  const adminSection = active.startsWith('manage-') ? active : '';
  return `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <a class="brand" href="#/${isAdmin ? 'manage-content' : 'dashboard'}"><span class="brand-mark">s</span><span><b>StudyNest</b><small>${isAdmin ? 'content administration' : 'your learning space'}</small></span></a>
        ${isAdmin ? `
        <div class="side-label">WORKSPACE</div>
        <nav class="admin-sidebar-nav">
          ${adminNavItem('Overview', 'manage-content', 'home', adminSection)}
        </nav>
        <div class="side-label">LEARNING CATALOG</div>
        <nav class="admin-sidebar-nav">
          ${adminNavItem('Subjects', 'manage-subjects', 'book', adminSection, management.subjects.length)}
          ${adminNavItem('Topics', 'manage-topics', 'cards', adminSection, management.topics.length)}
          ${adminNavItem('Lessons', 'manage-lessons', 'book', adminSection, management.lessons.length)}
          ${adminNavItem('Quizzes', 'manage-quizzes', 'quiz', adminSection, management.quizzes.length)}
        </nav>
        ${adminRole ? `<div class="side-label">PEOPLE & ACCESS</div><nav class="admin-sidebar-nav">${adminNavItem('Teachers', 'manage-teachers', 'settings', adminSection, teachers.length)}${adminNavItem('Students', 'manage-students', 'home', adminSection, students.length)}${adminNavItem('Applications', 'manage-applications', 'bell', adminSection, teacherApplications.length)}</nav>` : ''}
        <div class="side-label">ACCOUNT</div>
        <nav>${navItem('Profile settings', 'profile', 'settings', active)}</nav>
        ` : `
        <div class="side-label">YOUR SPACE</div>
        <nav>
          ${navItem('Overview', 'dashboard', 'home', active)}
          ${navItem('Study progress', 'progress', 'chart', active)}
          ${navItem('Recent activities', 'activities', 'book', active)}
          ${navItem('Notifications', 'notifications', 'bell', active)}
        </nav>
        <div class="side-label">STUDY & PRACTICE</div>
        <nav>
          ${navItem('Subjects', 'subjects', 'book', active)}
          ${navItem('Lessons', 'lessons', 'book', active)}
          ${navItem('My study sets', 'flashcards', 'cards', active)}
          ${navItem('My Private Library', 'my-library', 'book', active)}
          ${navItem('Practice quizzes', 'quizzes', 'quiz', active)}
        </nav>
        <div class="side-label">MORE</div>
        <nav>
          ${navItem('Favorites', 'favorites', 'heart', active)}
          ${navItem('Study schedule', 'schedule', 'calendar', active)}
          ${navItem('Profile settings', 'profile', 'settings', active)}
        </nav>
        `}
        <div class="sidebar-bottom">
          <div class="streak-card"><span class="streak-icon">${isAdmin ? '✎' : '✳'}</span><div><b>${isAdmin ? 'Content workspace' : 'Your learning'}</b><small>${isAdmin ? 'Manage the student catalog' : `${state.reviewedLessons.length} lessons reviewed`}</small></div></div>
          <button class="nav-item logout" data-action="logout">${icon('settings')}<span>Log out</span></button>
        </div>
      </aside>
      <main class="main-area">
        <header class="topbar">
          <button class="mobile-menu" data-action="menu" aria-label="Open navigation">☰</button>
          <div class="breadcrumbs"><span>StudyNest</span><span class="crumb-slash">/</span><b>${escapeHtml(title)}</b></div>
          <div class="topbar-actions">
            ${isAdmin ? '' : `<a class="icon-button" href="#/notifications" aria-label="${unreadNotificationCount() ? `${unreadNotificationCount()} unread notifications` : 'Notifications'}">${icon('bell')}${unreadNotificationCount() ? '<i></i>' : ''}</a>`}
            <a class="user-chip" href="#/profile"><span class="avatar">${escapeHtml(initials(name))}</span><span><b>${escapeHtml(name)}</b><small>${escapeHtml(state.user?.role || 'user')}</small></span><span class="chevron">⌄</span></a>
          </div>
        </header>
        <section class="page-content">${content}</section>
        <footer class="app-footer">A calmer way to study, one small step at a time. <span>Made for your next little win <b>✳</b></span></footer>
      </main>
    </div>`;
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
}

function heading(eyebrow, title, subtitle, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}

function metric(label, value, detail, tone = 'mint', iconText = '↗') {
  return `<article class="metric-card ${tone}"><div class="metric-top"><span>${label}</span><span class="metric-icon">${iconText}</span></div><strong>${value}</strong><small>${detail}</small></article>`;
}

function subjectCard(subject) {
  const isFavorite = state.favoriteSubjects.includes(subject.id);
  return `<article class="subject-card ${subject.color}"><div class="subject-top"><span class="subject-icon">${subject.icon}</span><div class="subject-card-actions"><span class="subject-count">${subject.lessons} lessons</span><button class="subject-favorite-button ${isFavorite ? 'is-favorite' : ''}" data-action="favorite-subject" data-id="${subject.id}" aria-label="${isFavorite ? 'Remove subject from favorites' : 'Add subject to favorites'}" title="${isFavorite ? 'Remove from favorites' : 'Add to favorites'}">${isFavorite ? '♥' : '♡'}</button></div></div><div class="subject-code">${escapeHtml(subject.short)} · ${subject.quizzes} quizzes</div><h3>${escapeHtml(subject.name)}</h3><p>${escapeHtml(subject.description || '')}</p><div class="progress-line"><span style="width:${subject.progress}%"></span></div><div class="progress-meta"><span>${subject.progress}% complete</span><a href="#/subject/${subject.id}">Explore topics <b>→</b></a></div></article>`;
}

function subjectDetail(id) {
  const subject = subjects.find((item) => item.id === Number(id));
  if (!subject) return shell(`${heading('SUBJECT', 'Subject not found', 'This subject may have been removed.') }<a href="#/subjects" class="button button-outline">← All subjects</a>`, 'Subject', 'subjects');
  const subjectTopics = topics.filter((topic) => Number(topic.subject_id) === subject.id);
  const certificateInfo = subject.certificate_enabled
    ? `<div class="soft-banner"><span>✳</span><div><b>Certificate available</b><small>Complete at least ${subject.required_completion_percent}% of this subject’s lessons${subject.quizzes ? ` and score at least ${subject.minimum_quiz_score}% on each quiz` : ''} to earn it.</small></div></div>`
    : '<div class="soft-banner"><span>♡</span><div><b>No certificate for this subject</b><small>The subject owner has not enabled completion certificates.</small></div></div>';
  return shell(`${heading(escapeHtml(subject.name.toUpperCase()), escapeHtml(subject.name), escapeHtml(subject.description || 'Explore the topics, lessons, and practice available in this subject.'), '<a href="#/subjects" class="button button-outline">← All subjects</a>')}${certificateInfo}<div class="topic-list">${subjectTopics.map((topic, index) => {
    const topicLessons = lessons.filter((lesson) => Number(lesson.topic_id) === topic.id);
    const topicQuizzes = quizzes.filter((quiz) => Number(quiz.topic_id) === topic.id);
    const completedLessons = topicLessons.filter((lesson) => state.reviewedLessons.includes(lesson.id)).length;
    return `<section class="panel topic-step"><div class="section-title"><div><div class="eyebrow">STEP ${index + 1} · ${escapeHtml(subject.name)}</div><h2>${escapeHtml(topic.title)}</h2></div><span class="tag tag-mint">${completedLessons}/${topicLessons.length} lessons · ${topicQuizzes.length} quizzes</span></div>${topic.summary ? `<p>${escapeHtml(topic.summary)}</p>` : ''}<div class="lesson-list">${topicLessons.map((lesson) => lessonCard(lesson, subject.id)).join('') || '<p class="empty-state">No lessons in this topic yet.</p>'}</div>${topicQuizzes.length ? `<div class="subject-quiz-links"><span class="eyebrow">PRACTICE THIS TOPIC</span>${topicQuizzes.map((quiz) => `<a class="button button-outline button-small" href="#/subject/${subject.id}/quiz/${quiz.id}">${escapeHtml(quiz.title)} · ${quiz.questions} questions</a>`).join('')}</div>` : '<p class="empty-state">No quizzes in this topic yet.</p>'}</section>`;
  }).join('') || '<p class="empty-state">No topics have been added for this subject yet.</p>'}</div>`, 'Subject topics', 'subjects');
}

function dashboard() {
  const averageScore = state.attempts.length
    ? Math.round(state.attempts.reduce((total, attempt) => total + Number(attempt.score), 0) / state.attempts.length)
    : 0;
  const nextSession = state.schedules.find((item) => new Date(`${item.date}T${item.time}`) >= new Date());
  const continueLesson = lessons.find((lesson) => state.reviewedLessons.includes(lesson.id)) || lessons[0];
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).toUpperCase();
  return shell(`
    ${heading(today, `A good day to learn, ${escapeHtml((state.user?.name || '').split(' ')[0])}.`, 'You’re showing up for yourself. That’s what counts.', '<a class="button button-primary" href="#/lessons">Continue studying <span>→</span></a>')}
    <div class="metric-grid">${metric('Lessons reviewed', state.reviewedLessons.length, 'A little progress adds up', 'mint', '▤')}${metric('Quizzes completed', state.attempts.length, 'You’re on a roll', 'peach', '✓')}${metric('Study sets', state.sets.length, 'Ready when you are', 'lavender', '▣')}${metric('Average quiz score', `${averageScore}%`, 'Across your completed quizzes', 'sky', '↗')}</div>
    <div class="dashboard-grid">
      <section class="panel continue-panel"><div class="section-title"><div><div class="eyebrow">PICK UP WHERE YOU LEFT OFF</div><h2>Continue studying</h2></div><a class="text-link" href="#/subjects">All subjects →</a></div>${continueLesson ? `<div class="continue-card"><div class="continue-art"><span>${escapeHtml(subjectIcon(continueLesson.subject))}</span><small>${escapeHtml(continueLesson.subject.toUpperCase())}</small></div><div class="continue-info"><span class="tag tag-mint">${escapeHtml(continueLesson.topic)}</span><h3>${escapeHtml(continueLesson.title)}</h3><p>${escapeHtml(continueLesson.subject)} · ${escapeHtml(continueLesson.read)}</p><a href="#/lesson/${continueLesson.id}" class="button button-small">Continue <b>→</b></a></div></div>` : '<p class="empty-state">No lessons are available yet.</p>'}</section>
      <section class="panel session-panel"><div class="section-title"><div><div class="eyebrow">A LITTLE PLANNING</div><h2>Next study session</h2></div><a class="text-link" href="#/schedule">See schedule →</a></div>${nextSession ? `<div class="next-session-date"><span class="date-day">${new Date(`${nextSession.date}T00:00`).getDate()}</span><span>${new Date(`${nextSession.date}T00:00`).toLocaleDateString('en-US', { month: 'short', weekday: 'long' })}</span></div><h3>${escapeHtml(nextSession.title)}</h3><p>${escapeHtml(nextSession.time)} · ${escapeHtml(nextSession.note || '')}</p><a href="#/schedule" class="session-link">View schedule <span>→</span></a>` : '<p class="empty-state">No upcoming sessions scheduled.</p>'}</section>
      <section class="panel subjects-panel"><div class="section-title"><div><div class="eyebrow">YOUR LEARNING PATH</div><h2>Your subjects</h2></div><a class="text-link" href="#/subjects">View all →</a></div><div class="subject-mini-list">${subjects.length ? subjects.map((s) => `<a class="subject-mini" href="#/subjects"><span class="mini-icon ${s.color}">${s.icon}</span><span><b>${escapeHtml(s.name)}</b><small>${s.lessons} lessons · ${s.progress}% complete</small></span><span class="mini-arrow">→</span></a>`).join('') : '<p class="empty-state">No subjects have been added.</p>'}</div></section>
      <section class="panel results-panel"><div class="section-title"><div><div class="eyebrow">YOU’RE GETTING THERE</div><h2>Recent quiz results</h2></div><a class="text-link" href="#/history">See history →</a></div><div class="results-list">${state.attempts.slice(0, 3).map((item) => `<div class="result-row"><span class="result-dot ${item.score >= 80 ? 'good' : 'warm'}"></span><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.subject)} · ${new Date(item.date).toLocaleDateString()}</small></span><strong>${item.score}%</strong></div>`).join('') || '<p class="empty-state">No quiz attempts yet.</p>'}</div></section>
    </div>
  `, 'Overview', 'dashboard');
}

function progressPage() {
  const averageScore = state.attempts.length
    ? Math.round(state.attempts.reduce((total, attempt) => total + Number(attempt.score), 0) / state.attempts.length)
    : 0;
  const studyHours = (state.studyTimeSeconds / 3600).toFixed(1);
  const dailyStudy = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return {
      label: date.toLocaleDateString('en-US', { weekday: 'short' }),
      seconds: Number(state.weeklyStudy.find((day) => day.study_date === key)?.duration_seconds || 0),
    };
  });
  const maxStudy = Math.max(1, ...dailyStudy.map((day) => day.seconds));
  return shell(`${heading('A VIEW OF YOUR JOURNEY', 'Study progress', 'Progress from your saved lessons and quiz attempts.', '<button class="button button-outline" data-action="download-report" data-report="progress">Download progress CSV ↓</button>')}
    <div class="metric-grid">${metric('Study time', `${studyHours} hrs`, 'Tracked lesson and quiz time', 'mint', '◷')}${metric('Lessons reviewed', state.reviewedLessons.length, 'Across your subjects', 'peach', '▤')}${metric('Quizzes completed', state.attempts.length, 'Every practice counts', 'lavender', '✓')}${metric('Average score', `${averageScore}%`, 'Across completed attempts', 'sky', '↗')}</div>
    <div class="dashboard-grid progress-grid"><section class="panel wide-panel"><div class="section-title"><div><div class="eyebrow">STEADY STEPS</div><h2>Study time over the last 7 days</h2></div></div><div class="chart-area"><div class="chart-y"><span>${Math.ceil(maxStudy / 3600)}h</span><span>${Math.ceil(maxStudy / 7200)}h</span><span>0h</span></div><div class="chart-bars">${dailyStudy.map((day) => `<div class="chart-column"><span style="height:${Math.max(day.seconds ? 4 : 0, day.seconds / maxStudy * 100)}%"></span><small>${day.label}</small></div>`).join('')}</div></div><div class="chart-legend"><span></span> Tracked study time</div></section><section class="panel"><div class="section-title"><div><div class="eyebrow">SUBJECT BY SUBJECT</div><h2>Lessons reviewed</h2></div></div><div class="performance-list">${subjects.map((s) => `<div class="performance-row"><div><span class="mini-icon ${s.color}">${s.icon}</span><b>${escapeHtml(s.name)}</b><strong>${s.progress}%</strong></div><div class="progress-line"><span style="width:${s.progress}%"></span></div></div>`).join('') || '<p class="empty-state">No subjects yet.</p>'}</div></section><section class="panel"><div class="section-title"><div><div class="eyebrow">ROOM TO GROW</div><h2>Topics to revisit</h2></div></div>${state.weakTopics.map((topic) => `<div class="weak-topic"><span class="topic-mark">↗</span><div><b>${escapeHtml(topic.title)}</b><small>${escapeHtml(topic.subject)} · ${topic.average_score}% average</small></div><a href="#/quizzes">Practice →</a></div>`).join('') || '<p class="empty-state">Complete quizzes to see topics that need a review.</p>'}</section></div>`, 'Study progress', 'progress');
}

function activitiesPage() {
  return shell(`${heading('YOUR SAVED LEARNING EVENTS', 'Recent activities', 'Activity recorded from your study sessions.') }<section class="panel activity-panel"><div class="section-title"><h2>Your learning timeline</h2></div>${state.activities.map((item) => `<div class="timeline-item"><span class="timeline-dot mint"></span><div><small>${item.date.toLocaleString()}</small><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.details || item.type.replaceAll('_', ' '))}</p></div></div>`).join('') || '<p class="empty-state">Your activity will appear here as you study.</p>'}</section>`, 'Recent activities', 'activities');
}

function notificationsPage() {
  const unreadCount = unreadNotificationCount();
  const action = unreadCount
    ? '<button class="button button-outline" data-action="mark-all-notifications-read">Mark all as read</button>'
    : '';
  return shell(`${heading('A FEW THINGS FOR YOU', 'Notifications', 'Updates about your learning and study schedule.', action)}<div class="notification-layout"><div class="notification-list">${state.notifications.map((item) => {
    const isRead = item.isRead || state.readNotificationIds.includes(item.id);
    const content = `<span class="notification-mark ${item.tone}">${icon('bell')}</span><span class="notification-copy"><small>${item.date.toLocaleString()}</small><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></span><span class="notification-status">${isRead ? 'Read' : 'Unread'}</span>`;
    const attrs = `class="panel notification-card ${isRead ? 'is-read' : 'is-unread'}" data-action="read-notification" data-id="${escapeHtml(item.id)}" aria-label="${isRead ? 'Read' : 'Unread'} notification: ${escapeHtml(item.title)}"`;
    return item.link
      ? `<a ${attrs} href="${escapeHtml(item.link.startsWith('#/') ? item.link : '#/notifications')}">${content}</a>`
      : `<button type="button" ${attrs}>${content}</button>`;
  }).join('') || '<div class="panel empty-panel"><h2>You’re all caught up</h2><p>New schedule reminders and learning updates will appear here.</p></div>'}</div><form class="panel notification-settings" id="notification-preferences"><div class="eyebrow">EMAIL PREFERENCES</div><h2>Choose your StudyNest emails</h2><p>Important learning updates can also arrive in your inbox.</p><label class="notification-preference"><span><b>Certificates</b><small>Get an email when you earn a certificate.</small></span><input type="checkbox" name="email_certificates" ${state.notificationPreferences.email_certificates ? 'checked' : ''} /></label><label class="notification-preference"><span><b>New subject content</b><small>Get an email when a new topic or lesson is added to a subject you’ve studied or favorited.</small></span><input type="checkbox" name="email_content_updates" ${state.notificationPreferences.email_content_updates ? 'checked' : ''} /></label><button class="button button-primary button-small" type="submit">Save email settings</button></form></div>`, 'Notifications', 'notifications');
}

function subjectsPage() {
  return shell(`${heading('FIND YOUR NEXT FOCUS', 'Your subjects', 'Pick a subject and take one small step forward.') }<div class="subject-grid">${subjects.map(subjectCard).join('') || '<p class="empty-state">There are no subjects yet.</p>'}</div><section class="soft-banner"><span>✳</span><div><b>Learning at your own pace</b><small>There’s no rush. Every lesson you complete is a win.</small></div><a href="#/lessons" class="button button-small">Browse lessons →</a></section>`, 'Subjects', 'subjects');
}

function lessonsPage() {
  return shell(`${heading('ONE IDEA AT A TIME', 'Lesson library', 'Explore bite-sized lessons made for curious minds.') }<div class="filter-bar"><label class="search-field"><span>⌕</span><input id="lesson-search" type="search" placeholder="Search lessons..." /></label><select id="lesson-subject"><option value="">All subjects</option>${subjects.map((s) => `<option>${escapeHtml(s.name)}</option>`).join('')}</select></div><div class="lesson-list" id="lesson-list">${lessons.map(lessonCard).join('') || '<p class="empty-state">There are no lessons yet.</p>'}</div>`, 'Lessons', 'lessons');
}

function lessonCard(lesson, subjectId = null) {
  const favorite = state.favorites.includes(lesson.id);
  const lessonRoute = subjectId === null ? `lesson/${lesson.id}` : `subject/${subjectId}/lesson/${lesson.id}`;
  return `<article class="panel lesson-card" data-title="${escapeHtml((lesson.title + ' ' + lesson.subject + ' ' + lesson.topic).toLowerCase())}" data-subject="${escapeHtml(lesson.subject)}"><span class="lesson-icon ${subjectColor(lesson.subject)}">${subjectIcon(lesson.subject)}</span><div class="lesson-copy"><div class="eyebrow">${escapeHtml(lesson.subject)} · ${escapeHtml(lesson.topic)}</div><h3>${escapeHtml(lesson.title)}</h3><p>${escapeHtml(lesson.read)} · A friendly, focused review.</p></div><button class="favorite-button ${favorite ? 'favorited' : ''}" data-action="favorite" data-id="${lesson.id}" aria-label="${favorite ? 'Remove favorite' : 'Add favorite'}">${favorite ? '♥' : '♡'}</button><a href="#/${lessonRoute}" class="button button-small button-outline">Read lesson →</a></article>`;
}

function subjectColor(subject) {
  if (subject.includes('Networking')) return 'mint';
  if (subject.includes('Database')) return 'peach';
  return 'lavender';
}

function subjectIcon(subject) {
  if (subject.includes('Networking')) return '⌁';
  if (subject.includes('Database')) return '▦';
  return '⌘';
}

function lessonDetail(id, subjectId = null) {
  const lesson = lessons.find((item) => item.id === Number(id));
  const subject = subjectId === null ? null : subjects.find((item) => item.id === Number(subjectId));
  const belongsToSubject = subject && topics.some((topic) => topic.id === Number(lesson?.topic_id) && topic.subject_id === subject.id);
  if (!lesson || (subjectId !== null && (!subject || !belongsToSubject))) return shell(`${heading('LESSON REVIEWER', 'Lesson not found', 'This lesson may have been removed.') }<a href="#/lessons" class="button button-outline">← All lessons</a>`, 'Lesson reviewer', 'lessons');
  const isFavorite = state.favorites.includes(lesson.id);
  const isRead = state.reviewedLessons.includes(lesson.id);
  const pdfUrl = `${apiBase}/api/lessons/${encodeURIComponent(lesson.id)}/pdf`;
  const returnLink = subject
    ? `<a href="#/subject/${subject.id}" class="button button-outline">← ${escapeHtml(subject.name)}</a>`
    : '<a href="#/lessons" class="button button-outline">← All lessons</a>';
  const practiceLink = subject
    ? `<a href="#/subject/${subject.id}" class="text-link">Practice this subject →</a>`
    : '<a href="#/quizzes" class="text-link">Try a practice quiz →</a>';
  const pdfResources = lesson.pdf_original_name
    ? `<section class="panel lesson-resource"><div class="resource-icon">PDF</div><div class="resource-copy"><b>${escapeHtml(lesson.pdf_original_name)}</b><small>Open the PDF here to mark this lesson as read.</small></div><div class="resource-actions"><button class="button button-outline button-small" data-action="view-lesson-pdf" data-id="${lesson.id}" ${state.pdfLoadingLessonId === lesson.id ? 'disabled aria-busy="true"' : ''}>${state.pdfLoadingLessonId === lesson.id ? 'Loading…' : state.activePdfLessonId === lesson.id && state.activePdfUrl ? 'PDF open' : 'View PDF ↗'}</button><a class="button button-primary button-small" href="${pdfUrl}?download=1">Download ↓</a></div></section>${state.pdfErrorMessage && state.activePdfLessonId === lesson.id ? `<p class="pdf-error" role="alert">${escapeHtml(state.pdfErrorMessage)}</p>` : ''}${state.activePdfLessonId === lesson.id ? `<section class="panel lesson-pdf-panel">${state.activePdfUrl ? `<iframe class="lesson-pdf-viewer" data-id="${lesson.id}" src="${state.activePdfUrl}" title="Lesson PDF: ${escapeHtml(lesson.pdf_original_name)}"></iframe><button class="text-link close-pdf-button" data-action="close-lesson-pdf">Close PDF</button>` : state.pdfLoadingLessonId === lesson.id ? '<p class="empty-state">Loading your lesson PDF…</p>' : ''}</section>` : ''}`
    : '';
  const readStatus = isRead
    ? 'Marked as read'
    : lesson.pdf_original_name
      ? 'View the attached PDF to mark this lesson as read.'
      : 'This lesson is marked as read when opened.';
  return shell(`${heading(escapeHtml(lesson.subject.toUpperCase()), escapeHtml(lesson.title), `${escapeHtml(lesson.topic)} · ${lesson.read}`, returnLink)}${pdfResources}<div class="lesson-detail-layout"><article class="panel lesson-content"><div class="lesson-toolbar"><span class="tag tag-mint">LESSON REVIEWER</span><button class="favorite-button ${isFavorite ? 'favorited' : ''}" data-action="favorite" data-id="${lesson.id}">${isFavorite ? '♥ Saved' : '♡ Save lesson'}</button></div><div class="lesson-speech-controls" aria-label="Lesson audio controls"><div class="lesson-speech-buttons"><button class="button button-outline button-small" data-action="read-lesson" data-id="${lesson.id}">▶ Read lesson</button><button class="button button-outline button-small" data-action="toggle-lesson-speech" disabled>Pause</button><button class="button button-outline button-small" data-action="stop-lesson-speech" disabled>Stop</button></div><span id="lesson-speech-status" role="status" aria-live="polite"></span></div><p class="lesson-read-status ${isRead ? 'is-read' : ''}" data-lesson-read-status="${lesson.id}">${readStatus}</p><p class="lesson-lead">${escapeHtml(lesson.content)}</p><h2>The key idea</h2><p>${escapeHtml(lesson.content)} Learning this one concept at a time helps build a clearer picture of how it all fits together.</p><div class="takeaway"><span>✳</span><div><b>Keep this in mind</b><p>Try explaining the idea in your own words. That’s a great way to make it stick.</p></div></div><div class="lesson-actions">${practiceLink}</div></article><aside class="panel toc-panel"><div class="eyebrow">IN THIS LESSON</div><h3>A quick guide</h3><a class="toc-link current" href="#lesson-overview">Overview</a><a class="toc-link" href="#lesson-key-idea">The key idea</a><a class="toc-link" href="#lesson-takeaway">Takeaway</a></aside></div>`, 'Lesson reviewer', 'lessons');
}

function flashcardsPage() {
  const search = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
  return shell(`${heading('KEEP THE GOOD STUFF CLOSE', 'My study sets', 'Create a set, add a few cards, and learn at your pace.', '<a href="#/flashcards/create" class="button button-primary">＋ Create a study set</a>')}<div class="filter-bar"><label class="search-field"><span>⌕</span><input id="set-search" type="search" value="${escapeHtml(search)}" placeholder="Search your sets..." /></label><select id="set-subject"><option value="">All subjects</option>${subjects.map((s) => `<option>${s.name}</option>`).join('')}</select><select id="set-sort"><option value="newest">Recently created</option><option value="az">Title: A to Z</option><option value="cards">Most cards</option></select></div><div class="studyset-grid" id="studyset-grid">${state.sets.map(setCard).join('')}</div>`, 'My study sets', 'flashcards');
}

function privateLibraryPage() {
  const subjectsMarkup = privateLibrary.map((subject) => `<section class="panel private-subject-card">
    <div class="section-title"><div><div class="eyebrow">YOUR PRIVATE SUBJECT</div><h2>${escapeHtml(subject.name)}</h2><p>${escapeHtml(subject.description || '')}</p></div>
    <div class="admin-content-actions"><button class="quiet-button" data-action="private-add-topic" data-id="${subject.id}">＋ Add topic</button><button class="quiet-button danger-text" data-action="private-delete" data-kind="subjects" data-id="${subject.id}" data-title="${escapeHtml(subject.name)}">Delete</button></div></div>
    ${(subject.topics || []).map((topic) => `<article class="private-topic-card"><div class="section-title"><div><span class="eyebrow">TOPIC</span><h3>${escapeHtml(topic.title)}</h3></div><div class="admin-content-actions"><button class="quiet-button" data-action="private-add-lesson" data-id="${topic.id}">＋ Lesson</button><button class="quiet-button" data-action="private-add-quiz" data-id="${topic.id}">＋ Quiz</button><button class="quiet-button danger-text" data-action="private-delete" data-kind="topics" data-id="${topic.id}" data-title="${escapeHtml(topic.title)}">Delete</button></div></div>
      <div class="private-content-list">
        ${(topic.lessons || []).map((lesson) => `<div class="private-content-row"><div><b>${escapeHtml(lesson.title)}</b><p class="private-lesson-notes">${escapeHtml(lesson.content || '')}</p>${lesson.pdf_original_name ? `<div class="private-pdf-actions"><a class="text-link" href="${apiBase}/api/my-library/lessons/${encodeURIComponent(lesson.id)}/pdf" target="_blank" rel="noopener">View PDF ↗</a><a class="text-link" href="${apiBase}/api/my-library/lessons/${encodeURIComponent(lesson.id)}/pdf?download=1">Download PDF ↓</a></div>` : ''}</div><button class="quiet-button danger-text" data-action="private-delete" data-kind="lessons" data-id="${lesson.id}" data-title="${escapeHtml(lesson.title)}">Delete</button></div>`).join('')}
        ${(topic.quizzes || []).map((quiz) => `<div class="private-content-row"><div><b>${escapeHtml(quiz.title)}</b><p>${quiz.questions} questions · ${quiz.time} minutes</p></div><div class="admin-content-actions"><button class="button button-outline button-small" data-action="start-quiz" data-id="private-${quiz.id}">Start quiz →</button><button class="quiet-button danger-text" data-action="private-delete" data-kind="quizzes" data-id="${quiz.id}" data-title="${escapeHtml(quiz.title)}">Delete</button></div></div>`).join('')}
        ${!(topic.lessons || []).length && !(topic.quizzes || []).length ? '<p class="empty-state">No lessons or quizzes yet. Add something to start studying.</p>' : ''}
      </div>
    </article>`).join('') || '<p class="empty-state">No topics yet.</p>'}
  </section>`).join('');
  return shell(`${heading('YOUR OWN STUDY SPACE', 'My Private Library', 'Create personal subjects, lesson notes, PDF materials, and practice quizzes. Only you can access this library.', '<button class="button button-primary" data-action="private-add-subject">＋ Create subject</button>')}
    <div class="private-library-actions"><a class="button button-outline" href="#/flashcards">My flashcards →</a></div>
    ${subjectsMarkup || '<section class="panel empty-panel"><span>✳</span><h2>Your private library starts here</h2><p>Create a subject to organize your own notes, PDFs, and quizzes. Nothing you add here is shared to the teacher catalog.</p><button class="button button-primary" data-action="private-add-subject">Create your first subject →</button></section>'}`,
  'My Private Library', 'my-library');
}

function privateLibraryForm(kind, id = '') {
  const subject = privateLibrary.find((item) => String(item.id) === String(id));
  const topic = privateLibrary.flatMap((item) => item.topics || []).find((item) => String(item.id) === String(id));
  const title = kind === 'subjects' ? 'Create a private subject'
    : kind === 'topics' ? 'Add a topic'
      : kind === 'lessons' ? 'Create a private lesson' : 'Create a practice quiz';
  let fields = '';
  if (kind === 'subjects') {
    fields = '<label>Subject name<input name="name" required maxlength="150" /></label><label>Description<textarea name="description" rows="3"></textarea></label>';
  } else if (kind === 'topics') {
    fields = `<input type="hidden" name="subject_id" value="${escapeHtml(subject?.id || '')}" /><label>Topic name<input name="title" required maxlength="180" /></label>`;
  } else if (kind === 'lessons') {
    fields = `<input type="hidden" name="topic_id" value="${escapeHtml(topic?.id || '')}" /><label>Lesson title<input name="title" required maxlength="180" /></label><label>Lesson notes<textarea name="content" required rows="7"></textarea></label><label>Attach PDF (optional)<input name="private_pdf" type="file" accept="application/pdf,.pdf" /><span class="form-help">PDF only, maximum 20 MB. It is stored privately with your lesson.</span></label>`;
  } else {
    fields = `<input type="hidden" name="topic_id" value="${escapeHtml(topic?.id || '')}" /><label>Quiz title<input name="title" required maxlength="180" /></label><label>Time limit (minutes)<input name="duration_minutes" type="number" min="1" max="180" value="15" required /></label><div id="quiz-question-fields">${questionFields({}, 0)}</div><button type="button" class="button button-outline button-small" data-action="add-content-question">＋ Add question</button>`;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `<form class="modal panel content-modal private-library-modal ${kind === 'quizzes' ? 'private-library-quiz-modal' : ''}" id="private-library-form" data-kind="${kind}"><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button><div class="eyebrow">ONLY YOU CAN SEE THIS CONTENT</div><h2>${title}</h2>${fields}<div class="form-actions"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Save to my library →</button></div></form>`;
  app.append(overlay);
}

function setCard(set) {
  const created = set.created_at ? new Date(set.created_at).toLocaleDateString() : '';
  const pdfLink = set.pdf_original_name ? `<div class="private-pdf-actions"><a href="${apiBase}/api/study-sets/${encodeURIComponent(set.id)}/pdf" class="text-link" target="_blank" rel="noopener">Open attached PDF ↗</a><a href="${apiBase}/api/study-sets/${encodeURIComponent(set.id)}/pdf?download=1" class="text-link">Download PDF ↓</a></div>` : '';
  return `<article class="panel set-card" data-title="${escapeHtml(`${set.title} ${set.subject}`.toLowerCase())}" data-subject="${escapeHtml(set.subject || '')}" data-cards="${set.cards.length}"><div class="set-art ${subjectColor(set.subject || '')}"><span>${subjectIcon(set.subject || '')}</span><small>${escapeHtml((set.subject || 'MY STUDY SET').toUpperCase())}</small></div><div class="set-card-body"><span class="eyebrow">${escapeHtml(set.topic || set.subject || 'MY STUDY SET')}</span><h3>${escapeHtml(set.title)}</h3><p>${escapeHtml(set.description || '')}</p><div class="set-meta"><span>▣ ${set.cards.length} cards</span><span>${created ? `Created ${escapeHtml(created)}` : ''}</span></div>${pdfLink}<div class="set-actions"><a href="#/study/${encodeURIComponent(set.id)}" class="button button-primary button-small">Study set →</a><a href="#/flashcards/edit/${encodeURIComponent(set.id)}" class="button button-outline button-small">Edit</a><button class="icon-text danger-text" data-action="delete-set" data-id="${escapeHtml(set.id)}">Delete</button></div></div></article>`;
}

function flashcardForm(id) {
  const set = state.sets.find((item) => item.id === id);
  const cards = set?.cards || [{ term: '', answer: '' }, { term: '', answer: '' }];
  const isCustomTopic = Boolean(set?.custom_topic);
  const existingTopic = topics.find((topic) => Number(topic.id) === Number(set?.topic_id))
    || topics.find((topic) => topic.title === set?.topic && topic.subject === set?.subject);
  const topicValue = isCustomTopic ? 'custom' : existingTopic ? String(existingTopic.id) : '';
  return shell(`${heading(set ? 'MAKE IT YOUR OWN' : 'A FEW IDEAS TO REMEMBER', set ? 'Edit study set' : 'Create a study set', 'A good set starts with one question you want to remember.') }<form class="panel form-panel" id="set-form" data-id="${escapeHtml(id || '')}" data-has-pdf="${set?.pdf_original_name ? 'true' : ''}"><div class="form-grid"><label>Study set title<input name="title" required maxlength="120" value="${escapeHtml(set?.title || '')}" placeholder="e.g. Networking essentials" /></label><div id="set-subject-field" ${isCustomTopic ? 'hidden' : ''}><label>Subject<select name="subject"><option value="">Choose a subject</option>${subjects.map((s) => `<option value="${escapeHtml(s.name)}" ${!isCustomTopic && set?.subject === s.name ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select></label></div><label class="full-field">Description<textarea name="description" rows="3" placeholder="What will you be learning?">${escapeHtml(set?.description || '')}</textarea></label><label>Topic<select name="topic_id" id="set-topic"><option value="">Choose a topic</option>${topics.map((topic) => `<option value="${topic.id}" ${String(topic.id) === topicValue ? 'selected' : ''}>${escapeHtml(topic.subject)} · ${escapeHtml(topic.title)}</option>`).join('')}<option value="custom" ${topicValue === 'custom' ? 'selected' : ''}>Choose my own (upload a PDF)</option></select></label><div class="full-field" id="custom-topic-fields" ${topicValue === 'custom' ? '' : 'hidden'}><label>My topic<input name="custom_topic" maxlength="180" value="${escapeHtml(set?.custom_topic || '')}" placeholder="e.g. My biology reviewer" /></label><label>Choose a PDF ${set?.pdf_original_name ? '<span class="optional">(optional, max 20 MB)</span>' : '<span class="optional">(required, max 20 MB)</span>'}<input name="study_pdf" type="file" accept="application/pdf,.pdf" ${!set?.pdf_original_name && topicValue === 'custom' ? 'required' : ''} /><small class="form-help">Select a PDF from your device. It will be saved with your study set and available on your other devices.</small></label>${set?.pdf_original_name ? `<div class="private-pdf-actions"><a class="text-link" href="${apiBase}/api/study-sets/${encodeURIComponent(set.id)}/pdf" target="_blank" rel="noopener">${escapeHtml(set.pdf_original_name)} ↗</a><a class="text-link" href="${apiBase}/api/study-sets/${encodeURIComponent(set.id)}/pdf?download=1">Download PDF ↓</a></div><label class="check-row"><input type="checkbox" name="remove_study_pdf" value="1" /> Remove current PDF</label>` : ''}</div></div><div class="form-section-title"><div><h2>Your flashcards</h2><p>Add a term on one side and its answer on the other.</p></div><button type="button" class="button button-outline button-small" data-action="add-card">＋ Add a card</button></div><div id="card-fields">${cards.map((card, index) => flashcardFields(card, index)).join('')}</div><div class="form-actions"><a href="#/flashcards" class="button button-outline">Cancel</a><button class="button button-primary" type="submit">${set ? 'Save changes' : 'Create study set'} <span>→</span></button></div></form>`, set ? 'Edit study set' : 'Create study set', 'flashcards');
}

function flashcardFields(card, index) {
  return `<div class="flashcard-edit-row"><div class="card-number">CARD ${String(index + 1).padStart(2, '0')}</div><label>Term / question<textarea name="term" required rows="2" placeholder="Write a question...">${escapeHtml(card.term)}</textarea></label><label>Answer / definition<textarea name="answer" required rows="2" placeholder="Write an answer...">${escapeHtml(card.answer)}</textarea></label><button type="button" class="remove-card" data-action="remove-card" aria-label="Remove card">×</button></div>`;
}

function studyPage(id) {
  const set = state.sets.find((item) => item.id === id);
  if (!set) return shell(`${heading('YOUR STUDY SPACE', 'Set not found', 'This set may have been removed.') }<a class="button button-primary" href="#/flashcards">Back to study sets</a>`, 'Study sets', 'flashcards');
  if (!flashcardSession || flashcardSession.setId !== id) flashcardSession = { setId: id, index: 0, flipped: false, order: set.cards.map((_, i) => i) };
  const index = flashcardSession.order[flashcardSession.index] || 0;
  const card = set.cards[index];
  if (!card) return shell(`${heading('YOUR STUDY SPACE', 'This set has no cards yet', 'Add flashcards to this set before starting a session.') }<a class="button button-outline" href="#/flashcards/edit/${encodeURIComponent(set.id)}">Edit study set</a>`, 'Study sets', 'flashcards');
  const count = set.cards.length;
  return shell(`${heading('A MOMENT FOR YOU', escapeHtml(set.title), `Card ${Math.min(flashcardSession.index + 1, count)} of ${count}`, '<a href="#/flashcards" class="button button-outline">Finish studying</a>')}<div class="study-wrap"><div class="study-progress-row"><span>Your progress</span><span>${flashcardSession.index + 1} / ${count}</span></div><div class="progress-line"><span style="width:${count ? ((flashcardSession.index + 1) / count) * 100 : 0}%"></span></div><button class="flashcard ${flashcardSession.flipped ? 'flipped' : ''}" data-action="flip"><span class="card-side-label">${flashcardSession.flipped ? 'THE ANSWER' : 'TERM / QUESTION'}</span><strong>${escapeHtml(flashcardSession.flipped ? card.answer : card.term)}</strong><small>Click to ${flashcardSession.flipped ? 'see the question' : 'reveal the answer'}</small></button><div class="study-controls"><button class="button button-outline" data-action="card-prev">← Previous</button><div><button class="quiet-button" data-action="shuffle">↻ Shuffle</button><button class="button button-primary" data-action="card-next">${flashcardSession.index === count - 1 ? 'Finish set' : 'Next card'} →</button></div></div></div>`, 'Interactive study', 'flashcards');
}

function quizzesPage() {
  return shell(`${heading('A QUICK CHECK-IN', 'Practice quizzes', 'Take your time. This is a space to learn, not to rush.') }<div class="filter-bar"><label class="search-field"><span>⌕</span><input id="quiz-search" type="search" placeholder="Find a quiz..." /></label><select id="quiz-subject"><option value="">All subjects</option>${subjects.map((s) => `<option>${escapeHtml(s.name)}</option>`).join('')}</select></div><div class="quiz-grid" id="quiz-grid">${quizzes.map((quiz) => quizCard(quiz)).join('') || '<p class="empty-state">No quizzes are available yet.</p>'}</div><a class="text-link history-link" href="#/history">View your quiz history →</a>`, 'Practice quizzes', 'quizzes');
}

function quizCard(quiz) {
  return `<article class="panel quiz-card" data-title="${escapeHtml(`${quiz.title} ${quiz.topic}`.toLowerCase())}" data-subject="${escapeHtml(quiz.subject)}"><div class="quiz-card-top"><span class="quiz-badge ${subjectColor(quiz.subject)}">✳</span><span class="tag tag-mint">${quiz.questions} questions</span></div><div class="eyebrow">${escapeHtml(quiz.subject)}</div><h3>${escapeHtml(quiz.title)}</h3><p>${escapeHtml(quiz.topic)}</p><div class="quiz-meta"><span>▤ ${quiz.questions} questions</span><span>◷ ${quiz.time} mins</span></div><a href="#/quiz/${quiz.id}" class="button button-primary button-full">Start a practice quiz →</a></article>`;
}

function quizStart(id, subjectId = null) {
  const quiz = quizzes.find((item) => item.id === Number(id));
  const subject = subjectId === null ? null : subjects.find((item) => item.id === Number(subjectId));
  const belongsToSubject = subject && topics.some((topic) => topic.id === Number(quiz?.topic_id) && topic.subject_id === subject.id);
  const returnRoute = subject ? `subject/${subject.id}` : 'quizzes';
  const backLink = `<a href="#/${returnRoute}" class="button button-outline">← Back to ${subject ? escapeHtml(subject.name) : 'quizzes'}</a>`;
  if (!quiz || (subjectId !== null && (!subject || !belongsToSubject))) return shell(`${heading('PRACTICE QUIZ', 'Quiz not found', 'This quiz is not part of the selected subject.')}${backLink}`, 'Practice quiz', 'quizzes');
  return shell(`${heading('JUST YOU AND THE NEXT QUESTION', escapeHtml(quiz.title), `${quiz.questions} questions · ${quiz.time} minutes`, backLink)}<div class="quiz-start-wrap"><div class="panel quiz-ready"><span class="ready-mark">✳</span><div class="eyebrow">A PRACTICE MOMENT</div><h2>Ready when you are.</h2><p>This is a relaxed practice. Take a breath, read each question, and choose what feels right. You’ll see helpful explanations at the end.</p><div class="ready-stats"><span><b>${quiz.questions}</b> questions</span><span><b>${quiz.time}</b> minutes available</span></div>${quiz.questions ? `<button class="button button-primary" data-action="start-quiz" data-id="${quiz.id}" data-return-route="${returnRoute}">Begin quiz <span>→</span></button>` : '<p class="empty-state">This quiz has no questions yet.</p>'}</div></div>`, 'Practice quiz', 'quizzes');
}

function activeQuiz() {
  const q = quizSession;
  if (!q) return render();
  const item = quizQuestions[q.index];
  const identification = item.type === 'identification';
  const remaining = Math.max(0, Math.ceil((q.deadline - performance.now()) / 1000));
  const timeLabel = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  return shell(`${heading(`QUESTION ${q.index + 1} OF ${quizQuestions.length}`, 'Stay curious.', identification ? 'Type your answer below. You can move between questions any time.' : 'Choose one answer. You can move between questions any time.', '<button class="button button-outline" data-action="exit-quiz">Leave quiz</button>')}<div class="quiz-timer ${remaining <= 60 ? 'is-urgent' : ''}" role="timer" aria-live="polite"><span>TIME REMAINING</span><strong id="quiz-countdown">${timeLabel}</strong><span id="quiz-timeout-message"></span><button class="button button-outline button-small" id="quiz-timeout-retry" data-action="submit-quiz" hidden>Retry submission</button></div><div class="quiz-progress"><span style="width:${((q.index + 1) / quizQuestions.length) * 100}%"></span></div><div class="active-quiz-layout"><article class="panel question-panel"><div class="question-top"><span class="tag tag-mint">QUESTION ${String(q.index + 1).padStart(2, '0')}</span><span class="question-type">${identification ? 'IDENTIFICATION' : item.type === 'true_false' ? 'TRUE / FALSE' : 'MULTIPLE CHOICE'}</span></div><h2>${escapeHtml(item.question)}</h2>${identification ? `<label class="identification-answer">Your answer<input id="identification-answer" type="text" maxlength="255" autocomplete="off" value="${escapeHtml(q.answers[q.index] || '')}" placeholder="Type your answer..." ${q.timeExpired ? 'disabled' : ''} /></label>` : `<div class="answer-list">${item.options.map((option, index) => `<button class="answer-option ${q.answers[q.index] === index ? 'selected' : ''}" data-action="answer" data-index="${index}" ${q.timeExpired ? 'disabled' : ''}><span>${item.type === 'true_false' ? (index === 0 ? 'T' : 'F') : String.fromCharCode(65 + index)}</span>${escapeHtml(option)}</button>`).join('')}</div>`}<div class="question-actions"><button class="button button-outline" data-action="question-prev" ${q.index === 0 || q.timeExpired ? 'disabled' : ''}>← Previous</button>${q.index < quizQuestions.length - 1 ? `<button class="button button-primary" data-action="question-next" ${q.timeExpired ? 'disabled' : ''}>Next question →</button>` : '<button class="button button-primary" data-action="submit-quiz">Finish practice ✓</button>'}</div></article><aside class="panel question-nav-panel"><div class="eyebrow">YOUR QUESTIONS</div><h3>Go at your own pace</h3><div class="question-numbers">${quizQuestions.map((_, i) => `<button class="${i === q.index ? 'current' : ''} ${q.answers[i] !== undefined && String(q.answers[i]).trim() !== '' ? 'answered' : ''}" data-action="jump-question" data-index="${i}" ${q.timeExpired ? 'disabled' : ''}>${String(i + 1).padStart(2, '0')}</button>`).join('')}</div><p><span class="legend-dot"></span> Answered <span class="legend-dot unfilled"></span> To do</p></aside></div>`, 'Active quiz', 'quizzes');
}

function stopQuizCountdown() {
  if (quizTimerInterval !== null) {
    clearInterval(quizTimerInterval);
    quizTimerInterval = null;
  }
}

function updateQuizCountdown() {
  if (!quizSession || route() !== 'active-quiz') {
    stopQuizCountdown();
    return;
  }
  const remaining = Math.max(0, Math.ceil((quizSession.deadline - performance.now()) / 1000));
  const display = document.querySelector('#quiz-countdown');
  if (display) {
    display.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  }
  document.querySelector('.quiz-timer')?.classList.toggle('is-urgent', remaining <= 60);
  if (remaining === 0 && !quizSession.timeExpired) {
    quizSession.timeExpired = true;
    stopQuizCountdown();
    render();
    document.querySelector('#quiz-timeout-message').textContent = 'Time is up. Submitting your answers…';
    void withLoading(() => submitActiveQuiz(true));
  }
}

function startQuizCountdown() {
  stopQuizCountdown();
  updateQuizCountdown();
  quizTimerInterval = setInterval(updateQuizCountdown, 250);
}

async function submitActiveQuiz(timeExpired = false) {
  if (!quizSession || quizSession.submitting) return;
  quizSession.submitting = true;
  if (timeExpired) quizSession.timeExpired = true;
  const answers = {};
  quizQuestions.forEach((question, index) => {
    const selected = quizSession.answers[index];
    if (selected === undefined || String(selected).trim() === '') return;
    answers[question.id] = question.type === 'identification'
      ? String(selected).trim()
      : question.type === 'true_false'
        ? question.options[selected]
        : String.fromCharCode(65 + selected);
  });
  const active = quizSession;
  const result = await apiCall(`${active.isPrivate ? '/my-library/quizzes' : '/quizzes'}/${encodeURIComponent(active.quizId)}/attempts`, {
    method: 'POST',
    body: JSON.stringify({ answers, timer_token: active.timerToken }),
  });
  if (!result) {
    if (quizSession === active) {
      active.submitting = false;
      if (timeExpired) {
        const message = document.querySelector('#quiz-timeout-message');
        if (message) message.textContent = 'Could not submit yet. Check your connection, then retry.';
        const retry = document.querySelector('#quiz-timeout-retry');
        if (retry) retry.hidden = false;
      }
    }
    return;
  }
  stopQuizCountdown();
  const quiz = quizzes.find((item) => Number(item.id) === Number(active.quizId));
  state.quizResult = {
    ...result,
    title: active.title || quiz?.title || '',
    subject: active.subject || quiz?.subject || '',
    review: result.review.map((item) => ({
      ...item,
      selected: item.type === 'identification'
        ? item.selected_option || undefined
        : item.type === 'true_false'
          ? item.options.indexOf(item.selected_option)
          : item.selected_option ? item.selected_option.charCodeAt(0) - 65 : undefined,
    })),
  };
  const attempt = {
    title: state.quizResult.title,
    subject: state.quizResult.subject,
    score: Number(result.percentage),
    date: new Date().toISOString(),
  };
  save('attempts', [attempt, ...state.attempts]);
  await refreshCertificates(true);
  go('quiz-results');
}

function quizResult() {
  const q = quizSession;
  const result = state.quizResult;
  const review = result?.review || quizQuestions.map((item, index) => ({
    ...item,
    correct: q?.answers[index] === item.answer,
    selected: q?.answers[index],
  }));
  const total = result?.total_questions ?? quizQuestions.length;
  const correct = result?.score ?? review.filter((item) => item.correct).length;
  const pct = result?.percentage ?? Math.round((correct / total) * 100);
  const returnRoute = q?.returnRoute || 'quizzes';
  const returnSubject = returnRoute.startsWith('subject/')
    ? subjects.find((subject) => subject.id === Number(returnRoute.split('/')[1]))?.name
    : null;
  return shell(`${heading('PRACTICE COMPLETE', 'Look at you go.', 'Every answer is a chance to learn something new.') }<div class="result-summary panel"><span class="result-illustration">${pct >= 60 ? '✳' : '♡'}</span><div class="eyebrow">YOUR PRACTICE RESULT</div><div class="big-score">${pct}<small>%</small></div><p>You got <b>${correct} of ${total}</b> questions right. ${pct >= 60 ? 'That’s something to feel good about.' : 'Every practice makes the next one a little easier.'}</p><div class="score-breakdown"><span><b>${correct}</b> Correct</span><span><b>${total - correct}</b> To revisit</span><span><b>${total}</b> Total questions</span></div><a href="#/${returnRoute}" class="button button-primary">Back to ${escapeHtml(returnSubject || 'quizzes')} →</a></div><section class="panel review-panel"><div class="section-title"><div><div class="eyebrow">A LITTLE REVIEW</div><h2>Answers & explanations</h2></div></div>${review.map((item) => `<div class="review-answer ${item.correct ? 'correct' : 'incorrect'}"><div class="review-label">${item.correct ? '✓ YOU GOT IT' : '↗ GOOD ONE TO REVISIT'}</div><h3>${escapeHtml(item.question)}</h3>${item.selected !== undefined ? `<p>Your answer: ${escapeHtml(item.type === 'identification' ? item.selected : item.options[item.selected] || 'Not answered')}</p>` : ''}<p><b>Answer: ${escapeHtml(item.type === 'identification' ? item.correct_option : item.options[item.answer] ?? item.correct_option)}</b></p><p>${escapeHtml(item.explanation)}</p></div>`).join('')}</section>`, 'Quiz results', 'quizzes');
}

function historyPage() {
  return shell(`${heading('EVERY PRACTICE COUNTS', 'Quiz history', 'Look back at how much you’ve been learning.', '<button class="button button-outline" data-action="download-report" data-report="history">Download quiz history CSV ↓</button>')}<section class="panel history-panel"><div class="section-title"><div><h2>Your recent quizzes</h2><p>A small snapshot of your practice so far.</p></div></div><div class="table-wrap"><table><thead><tr><th>QUIZ</th><th>SUBJECT</th><th>DATE</th><th>SCORE</th><th></th></tr></thead><tbody>${state.attempts.map((attempt) => `<tr><td><b>${escapeHtml(attempt.title)}</b></td><td>${escapeHtml(attempt.subject)}</td><td>${new Date(attempt.date).toLocaleString()}</td><td><span class="score-pill ${attempt.score >= 80 ? 'score-good' : ''}">${attempt.score}%</span></td><td><a class="text-link" href="#/quizzes">Practice again →</a></td></tr>`).join('') || '<tr><td colspan="5">No quiz attempts yet.</td></tr>'}</tbody></table></div></section>`, 'Quiz history', 'quizzes');
}

function favoritesPage() {
  const favoriteLessons = lessons.filter((lesson) => state.favorites.includes(lesson.id));
  const favoriteSubjects = subjects.filter((subject) => state.favoriteSubjects.includes(subject.id));
  const sections = `${favoriteSubjects.length ? `<section class="favorites-section"><div class="section-title"><div><div class="eyebrow">YOUR SUBJECTS</div><h2>Saved subjects</h2></div></div><div class="subject-grid">${favoriteSubjects.map(subjectCard).join('')}</div></section>` : ''}${favoriteLessons.length ? `<section class="favorites-section"><div class="section-title"><div><div class="eyebrow">YOUR LESSONS</div><h2>Saved lessons</h2></div></div><div class="lesson-list">${favoriteLessons.map(lessonCard).join('')}</div></section>` : ''}`;
  return shell(`${heading('THE THINGS YOU WANT TO REMEMBER', 'Favorites', 'Your saved subjects and lessons, all in one place.') }${sections || '<div class="panel empty-panel"><span>♡</span><h2>No favorites just yet</h2><p>Save a subject or lesson and it’ll be right here when you need it.</p><a class="button button-primary" href="#/subjects">Browse subjects →</a></div>'}`, 'Favorites', 'favorites');
}

function schedulePage() {
  const sorted = [...state.schedules].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return shell(`${heading('MAKE A LITTLE ROOM FOR YOU', 'Study schedule', 'A gentle plan, made at your pace.', '<button class="button button-primary" data-action="new-schedule">＋ Add a session</button>')}<div class="schedule-layout"><section class="panel schedule-panel"><div class="section-title"><div><div class="eyebrow">YOUR UPCOMING MOMENTS</div><h2>This week</h2></div><span class="tag tag-mint">${sorted.length} planned</span></div>${sorted.length ? sorted.map((item) => `<div class="schedule-item"><div class="schedule-date"><b>${new Date(`${item.date}T00:00`).getDate()}</b><small>${new Date(`${item.date}T00:00`).toLocaleDateString('en-US', { month: 'short' })}</small></div><div class="schedule-detail"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.time)} · ${escapeHtml(item.note || 'A moment for learning')}</p></div><button class="quiet-button" data-action="edit-schedule" data-id="${escapeHtml(item.id)}">Edit</button><button class="quiet-button danger-text" data-action="delete-schedule" data-id="${escapeHtml(item.id)}">Remove</button></div>`).join('') : '<p class="empty-state">No sessions planned yet. Add one when it feels right.</p>'}</section><aside class="panel schedule-note"><span class="note-star">✳</span><div class="eyebrow">A GENTLE REMINDER</div><h2>It’s okay to take it one step at a time.</h2><p>Your schedule is here to support you, not add pressure. Move things around whenever you need.</p></aside></div>`, 'Study schedule', 'schedule');
}

function scheduleForm(id = '') {
  const entry = state.schedules.find((item) => item.id === id) || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `<form class="modal panel" id="schedule-form" data-id="${escapeHtml(id)}"><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button><div class="eyebrow">${id ? 'EDIT A STUDY MOMENT' : 'MAKE A LITTLE TIME'}</div><h2>${id ? 'Update your session' : 'Add a study session'}</h2><label>Session title<input name="title" required maxlength="120" value="${escapeHtml(entry.title || '')}" placeholder="e.g. Review network devices" /></label><div class="form-grid"><label>Date<input name="date" type="date" required value="${escapeHtml(entry.date || '')}" /></label><label>Time<input name="time" type="time" required value="${escapeHtml(entry.time || '')}" /></label></div><label>A little reminder<input name="note" maxlength="180" value="${escapeHtml(entry.note || '')}" placeholder="e.g. Take a short break after" /></label><div class="form-actions"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">${id ? 'Save changes' : 'Add session'} →</button></div></form>`;
  app.append(overlay);
}

function managementPage() {
  const section = route().startsWith('manage-') ? route().slice('manage-'.length) : 'content';
  const descriptions = {
    subjects: ['Subjects', 'Organize your curriculum into clear, easy-to-navigate learning areas.', 'subjects', 'subject'],
    topics: ['Topics', 'Group related lessons and assessments under the right subject.', 'topics', 'topic'],
    lessons: ['Lessons', 'Create and maintain the learning material students rely on.', 'lessons', 'lesson'],
    quizzes: ['Quizzes', 'Build and manage practice assessments for your students.', 'quizzes', 'quiz'],
  };
  const questionCount = management.quizzes.reduce((total, quiz) => total + quiz.questions.length, 0);
  const summary = [
    ['Subjects', management.subjects.length, 'Learning areas', 'mint'],
    ['Topics', management.topics.length, 'Organized units', 'lavender'],
    ['Lessons', management.lessons.length, 'Student resources', 'sky'],
    ['Quizzes', management.quizzes.length, `${questionCount} questions`, 'peach'],
  ];

  if (section.startsWith('subject/')) {
    return managementSubjectDetail(Number(section.split('/')[1]));
  }

  if (section === 'content' || section === 'overview') {
    return shell(`${heading('WORKSPACE OVERVIEW', 'Welcome to your content studio', 'Manage your learning catalog from one clear, organized workspace.') }
      <div class="metric-grid admin-metrics">${summary.map(([label, value, description, tone]) => metric(label, value, description, tone, '▤')).join('')}</div>
      <section class="admin-welcome-panel"><div class="eyebrow">YOUR LEARNING CATALOG</div><h2>Everything your students need, organized in one place.</h2><p>Choose a section from the sidebar to create, edit, and organize its content.</p><div class="admin-quick-links">${[
        ['Subjects', 'manage-subjects', management.subjects.length, 'book'],
        ['Topics', 'manage-topics', management.topics.length, 'cards'],
        ['Lessons', 'manage-lessons', management.lessons.length, 'book'],
        ['Quizzes', 'manage-quizzes', management.quizzes.length, 'quiz'],
      ].map(([label, href, count, glyph]) => `<a class="admin-quick-link" href="#/${href}"><span class="admin-quick-icon">${icon(glyph)}</span><span><b>${label}</b><small>${count} ${label.toLowerCase()}</small></span><span class="admin-quick-arrow">→</span></a>`).join('')}</div></section>`,
    'Workspace overview', 'manage-content');
  }

  if (section === 'teachers' && state.user?.role === 'admin') {
    const body = `<div class="admin-record-list">${teachers.map((teacher) => `<article class="admin-record-row" data-admin-search="${escapeHtml(`${teacher.name} ${teacher.email} ${teacher.teacher_id || ''}`.toLowerCase())}">
      <span class="admin-record-icon">${icon('settings')}</span><div class="admin-content-copy"><b>${escapeHtml(teacher.name)}</b><small>${escapeHtml(teacher.email)}${teacher.teacher_id ? ` · ID: ${escapeHtml(teacher.teacher_id)}` : ''}</small></div><span class="role-badge">Teacher</span>
    </article>`).join('') || '<div class="admin-empty"><p>No teacher accounts yet. Add a teacher to share responsibility for the learning catalog.</p></div>'}</div>`;
    return shell(`${heading('PEOPLE & ACCESS', 'Teachers', 'Manage the teachers who can create and maintain learning content.', '<div class="page-heading-actions"><button class="button button-outline" data-action="download-report" data-report="teachers">Download CSV ↓</button><button class="button button-primary" data-action="new-teacher">＋ Add teacher</button></div>')}
      <section class="panel admin-section-panel"><div class="admin-list-toolbar"><div><b>Teacher accounts</b><small>${teachers.length} active ${teachers.length === 1 ? 'teacher' : 'teachers'}</small></div><label class="search-field"><span>⌕</span><input id="admin-content-search" type="search" aria-label="Search teachers" placeholder="Search teachers..." /></label></div>${body}</section>`,
    'Teachers', 'manage-teachers');
  }

  if (section === 'students' && state.user?.role === 'admin') {
    const body = `<div class="admin-record-list">${students.map((student) => `<article class="admin-record-row" data-admin-search="${escapeHtml(`${student.name} ${student.email}`.toLowerCase())}">
      <span class="admin-record-icon">${icon('home')}</span><div class="admin-content-copy"><b>${escapeHtml(student.name)}</b><small>${escapeHtml(student.email)}</small></div><span class="role-badge">Student</span><small>${Number(student.is_active) === 1 && student.email_verified_at ? 'Active' : 'Inactive or unverified'} · Joined ${escapeHtml(new Date(student.created_at).toLocaleDateString())}</small>
    </article>`).join('') || '<div class="admin-empty"><p>No student accounts yet.</p></div>'}</div>`;
    return shell(`${heading('PEOPLE & ACCESS', 'Students', 'View student accounts registered in StudyNest.', '<button class="button button-outline" data-action="download-report" data-report="students">Download student list CSV ↓</button>')}
      <section class="panel admin-section-panel"><div class="admin-list-toolbar"><div><b>Student accounts</b><small>${students.length} ${students.length === 1 ? 'student' : 'students'}</small></div><label class="search-field"><span>⌕</span><input id="admin-content-search" type="search" aria-label="Search students" placeholder="Search students..." /></label></div>${body}</section>`,
    'Students', 'manage-students');
  }

  if (section === 'applications' && state.user?.role === 'admin') {
    const body = `<div class="admin-record-list">${teacherApplications.map((application) => `<article class="admin-record-row teacher-application-item" data-admin-search="${escapeHtml(`${application.name} ${application.email}`.toLowerCase())}">
      <span class="admin-record-icon">${icon('bell')}</span><div class="admin-content-copy"><b>${escapeHtml(application.name)}</b><small>${escapeHtml(application.email)} · Teacher ID application</small>${application.teacher_id_photo_available ? `<a class="teacher-photo-link" href="${apiBase}/api/manage/teacher-applications/${application.id}/photo" target="_blank" rel="noopener">Review teacher ID photo ↗</a>` : '<small>Photo unavailable · applicant can upload it again from their application page</small>'}</div>
      <div class="admin-content-actions">${application.teacher_id_photo_available ? `<button class="quiet-button" data-action="review-teacher" data-id="${application.id}" data-decision="approve">Approve</button>` : ''}<button class="quiet-button danger-text" data-action="review-teacher" data-id="${application.id}" data-decision="reject">Reject</button></div>
    </article>`).join('') || '<div class="admin-empty"><p>You’re all caught up. There are no teacher applications waiting for review.</p></div>'}</div>`;
    return shell(`${heading('PEOPLE & ACCESS', 'Teacher applications', 'Review teacher ID photos and decide who can manage learning content.')}
      <section class="panel admin-section-panel"><div class="admin-list-toolbar"><div><b>Applications to review</b><small>${teacherApplications.length} waiting for approval</small></div><label class="search-field"><span>⌕</span><input id="admin-content-search" type="search" aria-label="Search applications" placeholder="Search applications..." /></label></div>${body}</section>`,
    'Teacher applications', 'manage-applications');
  }

  if (!descriptions[section]) {
    return shell(`${heading('WORKSPACE', 'Section unavailable', 'Choose a section from the sidebar to continue.')}`, 'Workspace', 'manage-content');
  }

  const [title, description, kind, singular] = descriptions[section];
  const entries = management[kind];
  const detail = {
    subjects: (entry) => entry.description || 'Subject',
    topics: (entry) => entry.subject || 'Topic',
    lessons: (entry) => `${entry.subject || 'Lesson'}${entry.topic ? ` · ${entry.topic}` : ''}`,
    quizzes: (entry) => `${entry.subject || 'Quiz'}${entry.topic ? ` · ${entry.topic}` : ''} · ${entry.time} min · ${entry.questions.length} questions`,
  }[kind];
  const rows = entries.map((entry) => {
    const name = entry.name || entry.title;
    const subtitle = kind === 'lessons' && entry.pdf_original_name
      ? `${detail(entry)} · PDF attached: ${entry.pdf_original_name}`
      : kind === 'subjects'
        ? `${detail(entry)} · ${Number(entry.certificate_enabled) === 1 || entry.certificate_enabled === true ? 'Certificates enabled' : 'Certificates disabled'}`
        : detail(entry);
    return `<article class="admin-record-row" data-admin-search="${escapeHtml(`${name} ${subtitle}`.toLowerCase())}">
      <span class="admin-record-icon">${icon(kind === 'quizzes' ? 'quiz' : kind === 'topics' ? 'cards' : 'book')}</span>
      ${kind === 'subjects' ? `<a class="admin-content-copy admin-subject-link" href="#/manage-subject/${entry.id}"><b>${escapeHtml(name)}</b><small>${escapeHtml(subtitle)} · Open subject details →</small></a>` : `<div class="admin-content-copy"><b>${escapeHtml(name)}</b><small>${escapeHtml(subtitle)}</small></div>`}
      <div class="admin-content-actions"><button class="quiet-button" data-action="edit-content" data-kind="${kind}" data-id="${entry.id}">Edit</button><button class="quiet-button danger-text" data-action="delete-content" data-kind="${kind}" data-id="${entry.id}" data-title="${escapeHtml(name)}">Delete</button></div>
    </article>`;
  }).join('') || `<div class="admin-empty"><p>No ${kind} yet. Add your first ${singular} to start building the student catalog.</p><button class="button button-outline button-small" data-action="new-content" data-kind="${kind}">＋ Create ${singular}</button></div>`;
  const headingAction = `<div class="page-heading-actions"><button class="button button-outline" data-action="download-report" data-report="catalog" data-kind="${kind}">Download CSV ↓</button><button class="button button-primary" data-action="new-content" data-kind="${kind}">＋ Add ${singular}</button></div>`;
  return shell(`${heading('LEARNING CATALOG', title, description, headingAction)}
    <section class="panel admin-section-panel"><div class="admin-list-toolbar"><div><b>All ${kind}</b><small>${entries.length} ${entries.length === 1 ? singular : kind} in your catalog</small></div><label class="search-field"><span>⌕</span><input id="admin-content-search" type="search" aria-label="Search ${kind}" placeholder="Search ${kind}..." /></label></div><div class="admin-record-list">${rows}</div></section>`,
  title, `manage-${section}`);
}

function managementSubjectDetail(subjectId) {
  const subject = management.subjects.find((item) => Number(item.id) === subjectId);
  if (!subject) {
    return shell(`${heading('LEARNING CATALOG', 'Subject not found', 'This subject may have been removed.', '<a href="#/manage-subjects" class="button button-outline">← All subjects</a>')}`, 'Subject', 'manage-subjects');
  }
  const subjectTopics = management.topics.filter((topic) => Number(topic.subject_id) === subjectId);
  const topicSections = subjectTopics.map((topic, index) => {
    const topicLessons = management.lessons.filter((lesson) => Number(lesson.topic_id) === Number(topic.id));
    const topicQuizzes = management.quizzes.filter((quiz) => Number(quiz.topic_id) === Number(topic.id));
    const contentRows = (items, kind, glyph) => items.map((item) => `<article class="admin-record-row">
      <span class="admin-record-icon">${icon(glyph)}</span><div class="admin-content-copy"><b>${escapeHtml(item.title)}</b><small>${kind === 'lessons' && item.pdf_original_name ? `PDF: ${escapeHtml(item.pdf_original_name)}` : kind === 'quizzes' ? `${item.time} min · ${item.questions.length} questions` : 'Lesson'}</small></div>
      <div class="admin-content-actions"><button class="quiet-button" data-action="edit-content" data-kind="${kind}" data-id="${item.id}">Edit</button><button class="quiet-button danger-text" data-action="delete-content" data-kind="${kind}" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Delete</button></div>
    </article>`).join('');
    return `<section class="panel admin-section-panel subject-management-topic"><div class="section-title"><div><div class="eyebrow">TOPIC ${index + 1}</div><h2>${escapeHtml(topic.title)}</h2>${topic.summary ? `<p>${escapeHtml(topic.summary)}</p>` : ''}</div><div class="admin-content-actions"><button class="quiet-button" data-action="edit-content" data-kind="topics" data-id="${topic.id}">Edit topic</button><button class="quiet-button danger-text" data-action="delete-content" data-kind="topics" data-id="${topic.id}" data-title="${escapeHtml(topic.title)}">Delete</button></div></div>
      <div class="section-title"><h3>Lessons <small>${topicLessons.length}</small></h3><button class="button button-outline button-small" data-action="new-content" data-kind="lessons" data-topic-id="${topic.id}">＋ Add lesson</button></div><div class="admin-record-list">${contentRows(topicLessons, 'lessons', 'book') || '<p class="empty-state">No lessons in this topic yet.</p>'}</div>
      <div class="section-title"><h3>Quizzes <small>${topicQuizzes.length}</small></h3><button class="button button-outline button-small" data-action="new-content" data-kind="quizzes" data-topic-id="${topic.id}">＋ Add quiz</button></div><div class="admin-record-list">${contentRows(topicQuizzes, 'quizzes', 'quiz') || '<p class="empty-state">No quizzes in this topic yet.</p>'}</div>
    </section>`;
  }).join('');
  const enabled = Number(subject.certificate_enabled) === 1 || subject.certificate_enabled === true;
  return shell(`${heading('SUBJECT WORKSPACE', escapeHtml(subject.name), escapeHtml(subject.description || 'Manage this subject’s topics, lessons, quizzes, and certificate rules.'), `<div class="page-heading-actions"><a href="#/manage-subjects" class="button button-outline">← All subjects</a><button class="button button-outline" data-action="edit-content" data-kind="subjects" data-id="${subject.id}">Edit subject</button><button class="button button-primary" data-action="new-content" data-kind="topics" data-subject-id="${subject.id}">＋ Add topic</button></div>`)}
    <section class="panel subject-certificate-summary"><div><div class="eyebrow">CERTIFICATE RULES</div><b>${enabled ? 'Certificates enabled' : 'Certificates disabled'}</b><p>${enabled ? `${Number(subject.required_completion_percent)}% lesson completion · ${Number(subject.minimum_quiz_score)}% minimum on every quiz` : 'Students will not earn a certificate for this subject.'}</p></div></section>
    <div class="subject-management-topics">${topicSections || '<section class="panel empty-panel"><h2>No topics yet</h2><p>Add a topic to start organizing this subject’s learning content.</p><button class="button button-primary" data-action="new-content" data-kind="topics" data-subject-id="${subject.id}">＋ Add the first topic</button></section>'}</div>`,
  subject.name, `manage-subject/${subject.id}`);
}

function teacherApplicationPage() {
  return `<main class="auth-screen"><section class="auth-story"><a class="brand brand-light" href="#/teacher-application"><span class="brand-mark">s</span><span><b>StudyNest</b><small>teacher application</small></span></a><div class="story-content"><div class="eyebrow">THANK YOU FOR APPLYING</div><h1>Your teaching space is almost ready.</h1><p>An administrator will review your submitted teacher ID photo. You can sign in again after your application is approved.</p><div class="story-doodle">✳</div></div><div class="story-footer">Your application is securely linked to ${escapeHtml(state.user?.email || 'your account')}.</div></section><section class="auth-form-side"><div class="application-status-card"><span class="application-status-icon">⌛</span><div class="eyebrow">APPLICATION STATUS</div><h2>Pending administrator review</h2><p>Your teacher ID photo is stored securely for the administrator to review. If your application was submitted before photo storage was fixed and the image is unavailable, upload it again here.</p><form id="teacher-id-resubmit-form" enctype="multipart/form-data"><label>Replace teacher ID photo<input name="teacher_id_photo" type="file" required accept="image/jpeg,image/png,image/webp" capture="environment" /><span class="form-help">JPEG, PNG, or WebP; maximum 5 MB.</span></label><button type="submit" class="button button-primary button-full">Upload ID photo →</button></form><button class="button button-outline button-full" data-action="logout">Log out</button></div></section></main>`;
}

function teacherForm() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `<form class="modal panel" id="teacher-form"><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button><div class="eyebrow">ACCOUNT MANAGEMENT</div><h2>Create a teacher account</h2><p class="form-help">Teachers can create and manage learning catalog content. They cannot create other teacher accounts.</p><label>Full name<input name="name" required maxlength="100" autocomplete="name" placeholder="Teacher name" /></label><label>Email address<input name="email" type="email" required maxlength="255" autocomplete="email" placeholder="teacher@example.com" /></label><label>Temporary password<input name="password" type="password" required minlength="8" autocomplete="new-password" placeholder="At least 8 characters" /></label><div class="form-actions"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Create teacher →</button></div></form>`;
  app.append(overlay);
}

function questionFields(question = {}, index = 0) {
  const type = question.type || 'multiple_choice';
  const correct = question.correct_option || '';
  const identification = type === 'identification';
  return `<div class="panel quiz-question-editor"><div class="form-section-title"><h3>Question ${index + 1}</h3><button type="button" class="quiet-button danger-text" data-action="remove-content-question">Remove</button></div><label>Question<textarea name="question_text" required rows="2">${escapeHtml(question.question_text || question.question || '')}</textarea></label><label>Type<select name="type" class="quiz-question-type"><option value="multiple_choice" ${type === 'multiple_choice' ? 'selected' : ''}>Multiple choice</option><option value="true_false" ${type === 'true_false' ? 'selected' : ''}>True / False</option><option value="identification" ${identification ? 'selected' : ''}>Identification</option></select></label><div class="form-grid quiz-option-fields" ${identification ? 'hidden' : ''}><label>Option A<input name="option_a" value="${escapeHtml(question.option_a || '')}" /></label><label>Option B<input name="option_b" value="${escapeHtml(question.option_b || '')}" /></label><label>Option C<input name="option_c" value="${escapeHtml(question.option_c || '')}" /></label><label>Option D<input name="option_d" value="${escapeHtml(question.option_d || '')}" /></label></div><label class="quiz-correct-select" ${identification ? 'hidden' : ''}>Correct answer<select name="correct_option" ${identification ? '' : 'required'}><option value="">Choose answer</option>${(type === 'true_false' ? ['True', 'False'] : ['A', 'B', 'C', 'D']).map((option) => `<option value="${option}" ${correct === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label><label class="quiz-correct-text" ${identification ? '' : 'hidden'}>Correct answer<input name="correct_option_text" maxlength="255" value="${escapeHtml(identification ? correct : '')}" ${identification ? 'required' : ''} placeholder="Enter the expected answer" /></label><label>Explanation<textarea name="explanation" rows="2">${escapeHtml(question.explanation || '')}</textarea></label></div>`;
}

function contentForm(kind, id = '', parentId = '') {
  const entries = management[kind] || [];
  const entry = entries.find((item) => String(item.id) === String(id)) || {};
  const title = entry.name || entry.title || '';
  let fields = '';
  if (kind === 'subjects') {
    const certificatesEnabled = Number(entry.certificate_enabled) === 1 || entry.certificate_enabled === true;
    fields = `<label>Subject name<input name="name" required maxlength="150" value="${escapeHtml(title)}" /></label><label>Description<textarea name="description" rows="3">${escapeHtml(entry.description || '')}</textarea></label><div class="form-section-title"><div><div class="eyebrow">CERTIFICATE SETTINGS</div><h2>Student completion certificate</h2></div></div><label class="check-row"><input name="certificate_enabled" type="checkbox" value="1" ${certificatesEnabled ? 'checked' : ''} /> Enable certificates for this subject</label><p class="form-help">When enabled, eligible students receive one downloadable certificate. Disabling it prevents new certificates from being issued.</p><div class="form-grid"><label>Required lesson completion (%)<input name="required_completion_percent" type="number" min="1" max="100" required value="${escapeHtml(entry.required_completion_percent ?? 100)}" /></label><label>Minimum score for each quiz (%)<input name="minimum_quiz_score" type="number" min="0" max="100" required value="${escapeHtml(entry.minimum_quiz_score ?? 70)}" /></label></div>`;
  } else if (kind === 'topics') {
    const subjectId = entry.subject_id ?? parentId;
    fields = `<label>Subject<select name="subject_id" required><option value="">Choose a subject</option>${management.subjects.map((subject) => `<option value="${subject.id}" ${Number(subjectId) === Number(subject.id) ? 'selected' : ''}>${escapeHtml(subject.name)}</option>`).join('')}</select></label><label>Topic title<input name="title" required maxlength="180" value="${escapeHtml(title)}" /></label><label>Summary<textarea name="summary" rows="3">${escapeHtml(entry.summary || '')}</textarea></label>`;
  } else if (kind === 'lessons') {
    const pdfUrl = `${apiBase}/api/lessons/${encodeURIComponent(id)}/pdf`;
    fields = `<label>Topic<select name="topic_id" required><option value="">Choose a topic</option>${management.topics.map((topic) => `<option value="${topic.id}" ${Number(entry.topic_id ?? parentId) === Number(topic.id) ? 'selected' : ''}>${escapeHtml(topic.subject)} · ${escapeHtml(topic.title)}</option>`).join('')}</select></label><label>Lesson title<input name="title" required maxlength="180" value="${escapeHtml(title)}" /></label><label>Lesson content<textarea name="content" required rows="8">${escapeHtml(entry.content || '')}</textarea></label><label>PDF study material <span class="optional">(optional, max 20 MB)</span><input name="pdf_attachment" type="file" accept="application/pdf,.pdf" /><small class="form-help">Students will be able to view or download this file from the lesson page.</small></label>${entry.pdf_original_name ? `<div class="current-pdf"><a href="${pdfUrl}" target="_blank" rel="noopener">View current PDF: ${escapeHtml(entry.pdf_original_name)} ↗</a><a href="${pdfUrl}?download=1" class="text-link">Download PDF ↓</a><label class="check-row"><input type="checkbox" name="remove_pdf_attachment" value="1" /> Remove current PDF</label></div>` : ''}`;
  } else {
    const questions = entry.questions?.length ? entry.questions : [{}];
    fields = `<label>Topic<select name="topic_id" required><option value="">Choose a topic</option>${management.topics.map((topic) => `<option value="${topic.id}" ${Number(entry.topic_id ?? parentId) === Number(topic.id) ? 'selected' : ''}>${escapeHtml(topic.subject)} · ${escapeHtml(topic.title)}</option>`).join('')}</select></label><label>Quiz title<input name="title" required maxlength="180" value="${escapeHtml(title)}" /></label><label>Duration in minutes<input name="duration_minutes" type="number" required min="1" max="600" value="${escapeHtml(entry.time || 15)}" /></label><div class="form-section-title"><h2>Quiz questions</h2><button type="button" class="button button-outline button-small" data-action="add-content-question">＋ Add question</button></div><div id="quiz-question-fields">${questions.map((question, index) => questionFields(question, index)).join('')}</div>`;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `<form class="modal panel content-modal" id="catalog-form" data-kind="${kind}" data-id="${escapeHtml(id)}"><button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button><div class="eyebrow">${id ? 'EDIT CONTENT' : 'ADD TO THE CATALOG'}</div><h2>${id ? 'Update' : 'Create'} ${kind.slice(0, -1)}</h2>${fields}<div class="form-actions"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Save content →</button></div></form>`;
  app.append(overlay);
}

function profilePage() {
  const certificateLink = state.user?.role === 'user'
    ? `<a href="#/certificates" class="button button-outline">My certificates (${state.certificates.length}) →</a>`
    : '';
  return shell(`${heading('THIS SPACE IS YOURS', 'Profile settings', 'A few details to make StudyNest feel like home.', certificateLink)}<form class="panel form-panel profile-form" id="profile-form"><div class="profile-avatar">${escapeHtml(initials(state.user?.name || ''))}</div><div class="form-grid"><label>Full name<input name="name" required maxlength="100" value="${escapeHtml(state.user?.name || '')}" /></label><label>Email address<input name="email" required type="email" value="${escapeHtml(state.user?.email || '')}" /></label><label class="full-field">New password <span class="optional">(leave blank to keep your current password)</span><input name="password" type="password" minlength="8" placeholder="At least 8 characters" /></label></div><div class="form-actions"><button type="submit" class="button button-primary">Save changes →</button></div></form>`, 'Profile settings', 'profile');
}

function certificatesPage() {
  const cards = state.certificates.map((certificate) => `<article class="panel certificate-card">
    <span class="certificate-mark">✳</span>
    <div><div class="eyebrow">CERTIFICATE OF COMPLETION</div><h2>${escapeHtml(certificate.subject_name)}</h2>
      <p>Awarded to ${escapeHtml(certificate.student_name)} · Created and taught by ${escapeHtml(certificate.teacher_name)}</p>
      <small>Issued ${escapeHtml(new Date(certificate.issued_at).toLocaleDateString())} · ID ${escapeHtml(certificate.certificate_code)}</small>
    </div>
    <a class="button button-primary" href="${apiBase}/api/certificates/${encodeURIComponent(certificate.id)}/download">Download certificate ↓</a>
  </article>`).join('');
  return shell(`${heading('YOUR ACHIEVEMENTS', 'My certificates', 'Earn a certificate when you meet the completion rules set by the subject’s teacher.', '<a href="#/profile" class="button button-outline">← Profile settings</a>')}
    <div class="certificate-list">${cards || '<section class="panel empty-panel"><span>✳</span><h2>No certificates yet</h2><p>Your teacher decides whether a subject offers a certificate and sets the lesson-completion and quiz-score requirements.</p><a class="button button-outline" href="#/subjects">Browse subjects →</a></section>'}</div>`,
  'My certificates', 'profile');
}

function loginPage(register = false) {
  return `<main class="auth-screen"><section class="auth-story"><a class="brand brand-light" href="#/login"><span class="brand-mark">s</span><span><b>StudyNest</b><small>your learning space</small></span></a><div class="story-content"><div class="eyebrow">A LITTLE PROGRESS, EVERY DAY</div><h1>Make room for what you want to learn.</h1><p>Find your focus. Build your rhythm.<br />Keep growing at your own pace.</p><div class="story-doodle">✳</div></div><div class="story-footer">A calmer way to study, one small step at a time.</div></section><section class="auth-form-side"><form class="auth-form" id="auth-form" data-register="${register}" enctype="multipart/form-data"><div class="eyebrow">${register ? 'A LOVELY PLACE TO BEGIN' : 'WELCOME BACK'}</div><h2>${register ? 'Create your account' : 'Sign in to StudyNest'}</h2><p>${register ? 'Your learning space is just a few details away.' : 'Pick up right where you left off.'}</p>${register ? `<label>Full name<input name="name" required maxlength="100" autocomplete="name" placeholder="Your name" /></label><label>Account type<select name="role" id="signup-role"><option value="student">Student</option><option value="teacher">Teacher</option></select></label><div id="teacher-id-field" hidden><label>Teacher ID photo<input name="teacher_id_photo" id="teacher-id-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" /><span class="form-help">Take a clear photo of your school-issued teacher ID, or upload an image. Maximum 5 MB.</span></label><img id="teacher-id-preview" class="teacher-id-preview" alt="Teacher ID photo preview" hidden /><p class="form-help">An administrator will review the photo before approving teacher access.</p></div>` : ''}<label>Email address<input name="email" required type="email" autocomplete="email" placeholder="you@example.com" /></label><label>Password<input name="password" required type="password" minlength="${register ? '8' : '1'}" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="${register ? 'At least 8 characters' : 'Your password'}" /></label><button type="submit" class="button button-primary button-full">${register ? 'Create my account' : 'Sign in'} <span>→</span></button><div class="auth-switch">${register ? 'Already have an account?' : 'New to StudyNest?'} <a href="#/${register ? 'login' : 'register'}">${register ? 'Sign in' : 'Create an account'}</a></div><a class="forgot-link" href="#/forgot-password">Forgot your password?</a><div class="auth-divider"><span>or</span></div><a href="#/google-auth" class="button button-google button-full">Continue with Google <span>↗</span></a><small class="google-note">${register ? 'Google sign-in will be available soon.' : 'Google sign-in will be available soon.'}</small></form></section></main>`;
}

function emailVerificationPage() {
  const email = sessionStorage.getItem('studynest_pending_email') || '';
  return `<main class="auth-screen"><section class="auth-story"><a class="brand brand-light" href="#/login"><span class="brand-mark">s</span><span><b>StudyNest</b><small>email verification</small></span></a><div class="story-content"><div class="eyebrow">ONE QUICK CHECK</div><h1>Verify your email to get started.</h1><p>Enter the six-digit code we sent to your inbox.</p><div class="story-doodle">✳</div></div></section><section class="auth-form-side"><form class="auth-form" id="verify-email-form"><div class="eyebrow">CHECK YOUR INBOX</div><h2>Enter your verification code</h2><p>We sent a time-limited code to <b>${escapeHtml(email || 'your email address')}</b>.</p><input type="hidden" name="email" value="${escapeHtml(email)}" /><label>Six-digit code<input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" /></label><button type="submit" class="button button-primary button-full">Verify email →</button><button type="button" class="button button-outline button-full" data-action="resend-otp" data-email="${escapeHtml(email)}">Send a new code</button><div class="auth-switch"><a href="#/login">← Back to sign in</a></div></form></section></main>`;
}

function renderLessonPage(lessonId, subjectId = null) {
  app.innerHTML = lessonDetail(lessonId, subjectId);
  updateLessonSpeechControls();
  const lesson = lessons.find((item) => item.id === lessonId);
  if (state.user.role === 'user' && lesson && !lesson.pdf_original_name && !state.reviewedLessons.includes(lessonId)) {
    markLessonAsRead(lessonId);
  }
}

function render() {
  const current = route();
  if (['login', 'register', 'google-auth', 'verify-email', 'forgot-password', 'reset-password'].includes(current)) {
    if (!authRoot) authRoot = createRoot(app);
    authRoot.render(createElement(AuthApp, {
      route: current,
      onAuthenticate: (...args) => withLoading(() => authenticate(...args)),
      onGoogleAuthenticate: (...args) => withLoading(() => authenticateWithGoogle(...args)),
      onVerify: (...args) => withLoading(() => verifyEmail(...args)),
      onResend: (...args) => withLoading(() => resendOtp(...args)),
      onForgotRequest: (...args) => withLoading(() => requestPasswordReset(...args)),
      onPasswordReset: (...args) => withLoading(() => resetPassword(...args)),
    }));
    return;
  }
  if (authRoot) {
    authRoot.unmount();
    authRoot = null;
  }
  const currentParts = current.split('/');
  const subjectLessonRoute = currentParts[0] === 'subject' && currentParts[2] === 'lesson';
  const lessonRoute = current.startsWith('lesson/') || subjectLessonRoute;
  if (lessonRoute) {
    const lessonId = Number(subjectLessonRoute ? currentParts[3] : currentParts[1]);
    if (state.activeLessonId !== lessonId) {
      releaseLessonPdf();
      state.activeLessonId = lessonId;
      state.lessonStartedAt = Date.now();
      state.activePdfLessonId = null;
      state.pdfLoadingLessonId = null;
      state.pdfErrorMessage = '';
    }
  } else {
    releaseLessonPdf();
    state.activeLessonId = null;
    state.activePdfLessonId = null;
    state.pdfLoadingLessonId = null;
    state.pdfErrorMessage = '';
    state.lessonStartedAt = 0;
  }
  const isManagementRoute = current === 'manage-content' || current.startsWith('manage-');
  if (!state.user) {
    go('login');
    return;
  } else if (state.user.role === 'teacher_pending') app.innerHTML = teacherApplicationPage();
  else if (canManageContent() && !isManagementRoute && current !== 'profile') {
    go('manage-content');
    return;
  } else if (canManageContent() && isManagementRoute) app.innerHTML = managementPage();
  else if (isManagementRoute) {
    go('dashboard');
    return;
  } else if (current === 'dashboard' || current === '') app.innerHTML = dashboard();
  else if (current === 'progress') app.innerHTML = progressPage();
  else if (current === 'activities') app.innerHTML = activitiesPage();
  else if (current === 'notifications') app.innerHTML = notificationsPage();
  else if (current === 'subjects') app.innerHTML = subjectsPage();
  else if (current.startsWith('subject/')) {
    const [, subjectId, nestedRoute, nestedId] = current.split('/');
    if (nestedRoute === 'lesson') renderLessonPage(Number(nestedId), subjectId);
    else app.innerHTML = nestedRoute === 'quiz'
      ? quizStart(nestedId, subjectId)
      : subjectDetail(subjectId);
  }
  else if (current === 'lessons') app.innerHTML = lessonsPage();
  else if (current.startsWith('lesson/')) renderLessonPage(Number(currentParts[1]));
  else if (current === 'flashcards') app.innerHTML = flashcardsPage();
  else if (current === 'my-library') app.innerHTML = privateLibraryPage();
  else if (current === 'flashcards/create') app.innerHTML = flashcardForm('');
  else if (current.startsWith('flashcards/edit/')) app.innerHTML = flashcardForm(decodeURIComponent(current.split('/')[2]));
  else if (current.startsWith('study/')) app.innerHTML = studyPage(decodeURIComponent(current.split('/')[1]));
  else if (current === 'quizzes') app.innerHTML = quizzesPage();
  else if (current.startsWith('quiz/')) app.innerHTML = quizStart(current.split('/')[1]);
  else if (current === 'active-quiz') app.innerHTML = activeQuiz();
  else if (current === 'quiz-results') app.innerHTML = quizResult();
  else if (current === 'history') app.innerHTML = historyPage();
  else if (current === 'favorites') app.innerHTML = favoritesPage();
  else if (current === 'schedule') app.innerHTML = schedulePage();
  else if (current === 'profile') app.innerHTML = profilePage();
  else if (current === 'certificates' && state.user.role === 'user') app.innerHTML = certificatesPage();
  else app.innerHTML = dashboard();
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function authenticate(values, registering) {
  if (registering && values.get('password').length < 8) {
    notify('Please use a password with at least 8 characters.');
    return;
  }
  if (registering && values.get('password') !== values.get('password_confirmation')) {
    notify('Your passwords do not match. Check both fields and try again.');
    return;
  }
  const result = await apiCall(`/auth/${registering ? 'register' : 'login'}`, {
    method: 'POST',
    body: registering
      ? values
      : JSON.stringify({
        email: values.get('email'),
        password: values.get('password'),
        recaptcha_token: values.get('recaptcha_token'),
      }),
  });
  if (!result) return;
  if (result.requires_email_verification) {
    sessionStorage.setItem('studynest_pending_email', result.email);
    go('verify-email');
    render();
    notify('Check your email for a six-digit verification code.');
    return;
  }
  save('user', result.user);
  go(state.user?.role === 'teacher_pending'
    ? 'teacher-application'
    : canManageContent(state.user?.role) ? 'manage-content' : 'dashboard');
  render();
  notify(registering
    ? values.get('role') === 'teacher' ? 'Email verified. Your teacher application is awaiting administrator review.' : 'Your StudyNest account is ready.'
    : state.user?.teacher_status === 'rejected'
      ? 'Your teacher application was not approved. You can continue using StudyNest as a student.'
      : 'Welcome back to your learning space.');
  await loadBackendState();
}

async function authenticateWithGoogle(credential, recaptchaToken) {
  const result = await apiCall('/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential, recaptcha_token: recaptchaToken }),
  });
  if (!result) return;
  save('user', result.user);
  go(state.user?.role === 'teacher_pending'
    ? 'teacher-application'
    : canManageContent(state.user?.role) ? 'manage-content' : 'dashboard');
  render();
  notify('Welcome to your StudyNest learning space.');
  await loadBackendState();
}

async function verifyEmail(values) {
  const result = await apiCall('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ email: values.get('email'), code: values.get('code') }),
  });
  if (!result) return;
  sessionStorage.removeItem('studynest_pending_email');
  go('login');
  render();
  notify('Email verified. You can now sign in.');
}

async function resendOtp(email) {
  const result = await apiCall('/auth/resend-otp', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (result) notify(result.message || 'If your account needs verification, a new code has been sent.');
}

async function requestPasswordReset(input) {
  const email = typeof input === 'string' ? input : input.get('email');
  const result = await apiCall('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (!result) return;
  sessionStorage.setItem('studynest_password_reset_email', email);
  go('reset-password');
  render();
  notify(result.message);
}

async function resetPassword(values) {
  if (values.get('password').length < 8) {
    notify('Your new password must be at least 8 characters long.');
    return;
  }
  if (values.get('password') !== values.get('password_confirmation')) {
    notify('Your passwords do not match. Check both fields and try again.');
    return;
  }
  const result = await apiCall('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({
      email: values.get('email'),
      code: values.get('code'),
      password: values.get('password'),
      password_confirmation: values.get('password_confirmation'),
    }),
  });
  if (!result) return;
  sessionStorage.removeItem('studynest_password_reset_email');
  go('login');
  render();
  notify(result.message);
}

app.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'auth-form' || form.id === 'verify-email-form') return;
  if (!form.reportValidity()) return;
  const finishLoading = beginLoading();
  try {
  if (form.id === 'notification-preferences') {
    const formValues = new FormData(form);
    const preferences = {
      email_certificates: formValues.has('email_certificates'),
      email_content_updates: formValues.has('email_content_updates'),
    };
    const result = await apiCall('/notification-preferences', {
      method: 'PUT',
      body: JSON.stringify(preferences),
    });
    if (!result) return;
    state.notificationPreferences = preferences;
    render();
    notify('Your email notification settings have been saved.');
    return;
  }
  if (form.id === 'teacher-id-resubmit-form') {
    const result = await apiCall('/auth/teacher-id-photo', {
      method: 'POST',
      body: new FormData(form),
    });
    if (!result) return;
    form.reset();
    notify(result.message);
    return;
  }
  if (form.id === 'teacher-form') {
    const values = formData(form);
    const result = await apiCall('/manage/teachers', {
      method: 'POST',
      body: JSON.stringify({
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
      }),
    });
    if (!result) return;
    document.querySelector('.modal-backdrop')?.remove();
    teachers = [...teachers, {
      id: Number(result.id),
      name: result.name,
      email: result.email,
      teacher_id: result.teacher_id || null,
      created_at: new Date().toISOString(),
    }];
    render();
    notify('Teacher account created successfully.');
    return;
  }
  if (form.id === 'catalog-form') {
    const kind = form.dataset.kind;
    const id = form.dataset.id;
    const values = formData(form);
    let payload = values;
    let requestBody;
    if (kind === 'subjects') {
      payload.certificate_enabled = form.elements.certificate_enabled.checked ? 1 : 0;
      payload.required_completion_percent = Number(values.required_completion_percent);
      payload.minimum_quiz_score = Number(values.minimum_quiz_score);
      requestBody = JSON.stringify(payload);
    } else if (kind === 'lessons') {
      requestBody = new FormData(form);
    } else if (kind === 'quizzes') {
      const questionRows = [...form.querySelectorAll('.quiz-question-editor')];
      payload.questions = questionRows.map((row) => {
        const question = Object.fromEntries([...row.querySelectorAll('[name]')].map((field) => [field.name, field.value]));
        question.correct_option = question.type === 'identification'
          ? question.correct_option_text
          : question.correct_option;
        delete question.correct_option_text;
        return {
          ...question,
          option_c: question.option_c || null,
          option_d: question.option_d || null,
        };
      });
      if (!payload.questions.length) {
        notify('Add at least one quiz question.');
        return;
      }
      payload.duration_minutes = Number(values.duration_minutes);
      requestBody = JSON.stringify(payload);
    } else {
      requestBody = JSON.stringify(payload);
    }
    const endpoint = kind === 'quizzes' ? '/manage/quizzes' : `/manage/${kind}`;
    const result = await apiCall(`${endpoint}${id ? `/${encodeURIComponent(id)}` : ''}`, {
      method: id && kind !== 'lessons' ? 'PUT' : 'POST',
      body: requestBody,
    });
    if (!result) return;
    document.querySelector('.modal-backdrop')?.remove();
    if (!await refreshManagementState()) return;
    notify(`Content ${id ? 'updated' : 'created'} successfully.`);
    return;
  }
  if (form.id === 'private-library-form') {
    const kind = form.dataset.kind;
    let payload = formData(form);
    let requestBody = JSON.stringify(payload);
    if (kind === 'lessons') {
      requestBody = new FormData(form);
    } else if (kind === 'quizzes') {
      payload.questions = [...form.querySelectorAll('.quiz-question-editor')].map((row) => {
        const question = Object.fromEntries([...row.querySelectorAll('[name]')].map((field) => [field.name, field.value]));
        question.correct_option = question.type === 'identification' ? question.correct_option_text : question.correct_option;
        delete question.correct_option_text;
        return { ...question, option_c: question.option_c || null, option_d: question.option_d || null };
      });
      if (!payload.questions.length) {
        notify('Add at least one quiz question.');
        return;
      }
      payload.duration_minutes = Number(payload.duration_minutes);
      requestBody = JSON.stringify(payload);
    }
    const result = await apiCall(`/my-library/${kind}`, { method: 'POST', body: requestBody });
    if (!result) return;
    document.querySelector('.modal-backdrop')?.remove();
    const library = await apiCall('/my-library');
    if (!Array.isArray(library)) return;
    privateLibrary = library;
    render();
    notify('Saved to your private library.');
    return;
  }
  if (form.id === 'set-form') {
    const terms = [...form.querySelectorAll('textarea[name="term"]')];
    const answers = [...form.querySelectorAll('textarea[name="answer"]')];
    const cards = terms.map((term, index) => ({ term: term.value.trim(), answer: answers[index].value.trim() }));
    if (!cards.length || cards.some((card) => !card.term || !card.answer)) {
      notify('Add at least one complete flashcard before saving.');
      return;
    }
    const id = form.dataset.id || `set-${Date.now()}`;
    const exists = state.sets.some((item) => item.id === id);
    const body = new FormData(form);
    body.set('cards', JSON.stringify(cards));
    if (body.get('topic_id') !== 'custom') body.delete('study_pdf');
    const result = await apiCall(exists ? `/study-sets/${encodeURIComponent(id)}` : '/study-sets', {
      method: exists ? 'PUT' : 'POST',
      body,
    });
    if (!result) return;
    const savedSet = { ...result, id: String(result.id) };
    save('sets', exists
      ? state.sets.map((item) => item.id === id ? savedSet : item)
      : [savedSet, ...state.sets]);
    notify(exists ? 'Your study set has been updated.' : 'Your new study set is ready.');
    go('flashcards');
    return;
  }
  if (form.id === 'schedule-form') {
    const values = formData(form);
    const entry = { id: form.dataset.id || `sch-${Date.now()}`, title: values.title.trim(), date: values.date, time: values.time, note: values.note.trim() };
    const result = await apiCall('/schedules', {
      method: 'POST',
      body: JSON.stringify({ ...entry, id: form.dataset.id || undefined }),
    });
    if (!result) return;
    const savedEntry = { ...result, id: String(result.id), time: result.time.slice(0, 5) };
    save('schedules', form.dataset.id
      ? state.schedules.map((item) => item.id === savedEntry.id ? savedEntry : item)
      : [...state.schedules, savedEntry]);
    document.querySelector('.modal-backdrop')?.remove();
    render();
    notify('Your study schedule has been updated.');
    return;
  }
  if (form.id === 'profile-form') {
    const values = formData(form);
    const result = await apiCall('/profile', {
      method: 'PUT',
      body: JSON.stringify({ name: values.name.trim(), email: values.email.trim(), password: values.password }),
    });
    if (!result) return;
    if (result.requires_email_verification) {
      sessionStorage.setItem('studynest_pending_email', result.email);
      save('user', null);
      go('verify-email');
      render();
      notify('Verify your new email address before signing in again.');
      return;
    }
    save('user', result.user);
    render();
    notify('Your profile has been saved.');
  }
  } finally {
    finishLoading();
  }
});

app.addEventListener('input', (event) => {
  if (['lesson-search', 'set-search', 'quiz-search'].includes(event.target.id)) filterCards();
  if (event.target.id === 'identification-answer' && quizSession) {
    if (quizSession.timeExpired) return;
    quizSession.answers[quizSession.index] = event.target.value;
    const number = document.querySelector(`.question-numbers [data-index="${quizSession.index}"]`);
    number?.classList.toggle('answered', event.target.value.trim() !== '');
  }
  if (event.target.id === 'admin-content-search') {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('.admin-record-row').forEach((item) => {
      item.hidden = !item.dataset.adminSearch.includes(query);
    });
  }
});
app.addEventListener('change', (event) => {
  if (['lesson-subject', 'set-subject', 'set-sort', 'quiz-subject'].includes(event.target.id)) filterCards();
  if (event.target.id === 'set-subject') updateStudySetTopics(event.target.value);
  if (event.target.id === 'set-topic') {
    const subjectField = document.querySelector('#set-subject-field');
    const subjectSelect = document.querySelector('#set-form [name="subject"]');
    const isCustom = event.target.value === 'custom';
    if (subjectField) subjectField.hidden = isCustom;
    if (isCustom && subjectSelect) {
      subjectSelect.value = '';
      updateStudySetTopics('', false);
    }
    const customTopicFields = document.querySelector('#custom-topic-fields');
    if (customTopicFields) customTopicFields.hidden = !isCustom;
    const pdfInput = customTopicFields?.querySelector('[name="study_pdf"]');
    if (pdfInput) pdfInput.required = isCustom && !document.querySelector('#set-form')?.dataset.hasPdf;
  }
  if (event.target.matches('.quiz-question-type')) {
    const row = event.target.closest('.quiz-question-editor');
    const type = event.target.value;
    const choices = type === 'true_false' ? ['True', 'False'] : ['A', 'B', 'C', 'D'];
    const correctLabel = row.querySelector('.quiz-correct-select');
    const textLabel = row.querySelector('.quiz-correct-text');
    const optionFields = row.querySelector('.quiz-option-fields');
    const correct = row.querySelector('[name="correct_option"]');
    const textCorrect = row.querySelector('[name="correct_option_text"]');
    correct.innerHTML = `<option value="">Choose answer</option>${choices.map((choice) => `<option value="${choice}">${choice}</option>`).join('')}`;
    const identification = type === 'identification';
    correctLabel.hidden = identification;
    textLabel.hidden = !identification;
    correct.required = !identification;
    textCorrect.required = identification;
    optionFields.hidden = identification;
    ['option_a', 'option_b', 'option_c', 'option_d'].forEach((name) => {
      row.querySelector(`[name="${name}"]`).disabled = type === 'true_false' && !['option_a', 'option_b'].includes(name)
        || identification;
    });
  }
});

function filterCards() {
  const lessonSearch = document.querySelector('#lesson-search')?.value.toLowerCase() || '';
  const lessonSubject = document.querySelector('#lesson-subject')?.value || '';
  document.querySelectorAll('.lesson-card').forEach((card) => {
    card.hidden = !(card.dataset.title.includes(lessonSearch) && (!lessonSubject || card.dataset.subject === lessonSubject));
  });
  const setSearch = document.querySelector('#set-search')?.value.toLowerCase() || '';
  const setSubject = document.querySelector('#set-subject')?.value || '';
  const sets = [...document.querySelectorAll('.set-card')];
  sets.forEach((card) => { card.hidden = !(card.dataset.title.includes(setSearch) && (!setSubject || card.dataset.subject === setSubject)); });
  const sort = document.querySelector('#set-sort')?.value;
  if (sort) {
    const parent = document.querySelector('#studyset-grid');
    sets.sort((a, b) => sort === 'az' ? a.dataset.title.localeCompare(b.dataset.title) : sort === 'cards' ? Number(b.dataset.cards) - Number(a.dataset.cards) : 0).forEach((card) => parent.append(card));
  }
  const quizSearch = document.querySelector('#quiz-search')?.value.toLowerCase() || '';
  const quizSubject = document.querySelector('#quiz-subject')?.value || '';
  document.querySelectorAll('.quiz-card').forEach((card) => {
    card.hidden = !(card.dataset.title.includes(quizSearch) && (!quizSubject || card.dataset.subject === quizSubject));
  });
}

function updateStudySetTopics(subjectName, dispatchTopicChange = true) {
  const select = document.querySelector('#set-topic');
  if (!select) return;
  const selected = select.value;
  const availableTopics = subjectName ? topics.filter((topic) => topic.subject === subjectName) : topics;
  select.innerHTML = `<option value="">Choose a topic</option>${availableTopics.map((topic) => `<option value="${topic.id}">${escapeHtml(topic.subject)} · ${escapeHtml(topic.title)}</option>`).join('')}<option value="custom">Choose my own (upload a PDF)</option>`;
  if (selected === 'custom' || availableTopics.some((topic) => String(topic.id) === selected)) {
    select.value = selected;
  }
  if (dispatchTopicChange) select.dispatchEvent(new Event('change', { bubbles: true }));
}

app.addEventListener('click', async (event) => {
  if (event.target.closest('.admin-nav-item')) {
    document.querySelector('#sidebar')?.classList.remove('open');
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  const finishLoading = beginLoading();
  try {
  if (action === 'read-lesson') {
    const lesson = lessons.find((item) => item.id === Number(id));
    if (lesson) readLessonAloud(lesson);
  } else if (action === 'toggle-lesson-speech') {
    if (lessonSpeech.status === 'speaking') {
      window.speechSynthesis.pause();
      lessonSpeech.status = 'paused';
    } else if (lessonSpeech.status === 'paused') {
      window.speechSynthesis.resume();
      lessonSpeech.status = 'speaking';
    }
    updateLessonSpeechControls();
  } else if (action === 'stop-lesson-speech') {
    stopLessonSpeech();
  } else if (action === 'read-notification') {
    const destination = button instanceof HTMLAnchorElement ? button.getAttribute('href') : null;
    if (destination) event.preventDefault();
    await markNotificationAsRead(id);
    if (destination) location.hash = destination;
  } else if (action === 'mark-all-notifications-read') {
    await markAllNotificationsAsRead();
  } else if (action === 'download-report') {
    downloadReport(button.dataset.report, button.dataset.kind || '');
  } else if (action === 'resend-otp') {
    const result = await apiCall('/auth/resend-otp', {
      method: 'POST',
      body: JSON.stringify({ email: button.dataset.email || '' }),
    });
    if (result) notify(result.message || 'If your account needs verification, a new code has been sent.');
  } else if (action === 'logout') {
    const result = await apiCall('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    if (!result) return;
    save('user', null);
    notify('You’ve signed out. See you soon.');
    go('login');
  } else if (action === 'menu') {
    document.querySelector('#sidebar')?.classList.toggle('open');
  } else if (action === 'new-content' || action === 'edit-content') {
    const parentId = button.dataset.kind === 'topics'
      ? button.dataset.subjectId || ''
      : button.dataset.topicId || '';
    contentForm(button.dataset.kind, action === 'edit-content' ? id : '', parentId);
  } else if (action === 'private-add-subject') {
    privateLibraryForm('subjects');
  } else if (action === 'private-add-topic') {
    privateLibraryForm('topics', id);
  } else if (action === 'private-add-lesson') {
    privateLibraryForm('lessons', id);
  } else if (action === 'private-add-quiz') {
    privateLibraryForm('quizzes', id);
  } else if (action === 'private-delete') {
    if (!window.confirm(`Delete "${button.dataset.title}" and its contents? This cannot be undone.`)) return;
    const result = await apiCall(`/my-library/${button.dataset.kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!result) return;
    const library = await apiCall('/my-library');
    if (!Array.isArray(library)) return;
    privateLibrary = library;
    render();
    notify('Private library item deleted.');
  } else if (action === 'new-teacher') {
    teacherForm();
  } else if (action === 'review-teacher') {
    const decision = button.dataset.decision;
    const message = decision === 'approve'
      ? 'Approve this teacher application? The applicant will gain access to content management.'
      : 'Reject this teacher application? The applicant account will remain a student account.';
    if (!window.confirm(message)) return;
    const result = await apiCall(`/manage/teacher-applications/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ decision }),
    });
    if (!result) return;
    const applicationId = Number(id);
    teacherApplications = teacherApplications.filter((application) => Number(application.id) !== applicationId);
    if (result.decision === 'approve') {
      teachers = [...teachers, result.account];
    } else {
      students = [result.account, ...students];
    }
    render();
    notify(decision === 'approve' ? 'Teacher application approved.' : 'Teacher application rejected.');
  } else if (action === 'add-content-question') {
    const container = document.querySelector('#quiz-question-fields');
    if (!container) return;
    container.insertAdjacentHTML('beforeend', questionFields({}, container.children.length));
    container.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else if (action === 'remove-content-question') {
    const rows = document.querySelectorAll('.quiz-question-editor');
    if (rows.length <= 1) notify('A quiz needs at least one question.');
    else button.closest('.quiz-question-editor').remove();
  } else if (action === 'delete-content') {
    const cascadeWarning = {
      subjects: 'This also permanently removes its topics, lessons, quizzes, and related quiz attempts.',
      topics: 'This also permanently removes its lessons, quizzes, and related quiz attempts.',
      lessons: 'Students will no longer be able to review or favorite this lesson.',
      quizzes: 'This also permanently removes its questions and students’ attempts.',
    }[button.dataset.kind] || 'This action cannot be undone.';
    if (!window.confirm(`Delete "${button.dataset.title}"?\n\n${cascadeWarning}`)) return;
    const endpoint = button.dataset.kind === 'quizzes' ? '/manage/quizzes' : `/manage/${button.dataset.kind}`;
    const result = await apiCall(`${endpoint}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!result) return;
    if (!await refreshManagementState()) return;
    notify('Content deleted.');
  } else if (action === 'favorite') {
    const lessonId = Number(id);
    const result = await apiCall('/favorites', {
      method: 'POST',
      body: JSON.stringify({ lesson_id: lessonId }),
    });
    if (!result) return;
    const favorites = result.saved
      ? [...new Set([...state.favorites, lessonId])]
      : state.favorites.filter((item) => item !== lessonId);
    save('favorites', favorites);
    render();
    notify(result.saved ? 'Lesson saved to your favorites.' : 'Lesson removed from your favorites.');
  } else if (action === 'favorite-subject') {
    const subjectId = Number(id);
    const result = await apiCall('/subject-favorites', {
      method: 'POST',
      body: JSON.stringify({ subject_id: subjectId }),
    });
    if (!result) return;
    state.favoriteSubjects = result.saved
      ? [...new Set([...state.favoriteSubjects, subjectId])]
      : state.favoriteSubjects.filter((item) => item !== subjectId);
    render();
    notify(result.saved ? 'Subject saved to your favorites.' : 'Subject removed from your favorites.');
  } else if (action === 'view-lesson-pdf') {
    const lessonId = Number(id);
    releaseLessonPdf();
    state.activePdfLessonId = lessonId;
    state.pdfLoadingLessonId = lessonId;
    state.pdfErrorMessage = '';
    render();
    try {
      const response = await fetch(`${apiBase}/api/lessons/${encodeURIComponent(lessonId)}/pdf`, {
        credentials: 'include',
        headers: { Accept: 'application/pdf' },
      });
      if (!response.ok) {
        let message = `Unable to open this PDF (${response.status}).`;
        try {
          const payload = await response.json();
          if (payload.error) message = payload.error;
        } catch {
          // Keep the HTTP status message when the server does not return JSON.
        }
        throw new Error(message);
      }
      const pdf = await response.blob();
      if (await pdf.slice(0, 5).text() !== '%PDF-') {
        throw new Error('The server response is not a valid PDF. Please upload the lesson PDF again or contact your administrator.');
      }
      if (state.activePdfLessonId !== lessonId) return;
      state.activePdfUrl = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    } catch (error) {
      if (state.activePdfLessonId === lessonId) {
        state.pdfErrorMessage = error instanceof Error
          ? error.message
          : 'Unable to open this PDF. Check your connection and try again.';
      }
    } finally {
      if (state.pdfLoadingLessonId === lessonId) state.pdfLoadingLessonId = null;
      if (state.activeLessonId === lessonId) render();
    }
  } else if (action === 'close-lesson-pdf') {
    releaseLessonPdf();
    state.activePdfLessonId = null;
    state.pdfLoadingLessonId = null;
    state.pdfErrorMessage = '';
    render();
  } else if (action === 'delete-set') {
    if (window.confirm('Delete this study set and all its cards?')) {
      const result = await apiCall(`/study-sets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!result) return;
      save('sets', state.sets.filter((set) => set.id !== id));
      render();
      notify('Study set deleted.');
    }
  } else if (action === 'add-card') {
    const fields = document.querySelectorAll('.flashcard-edit-row');
    document.querySelector('#card-fields').insertAdjacentHTML('beforeend', flashcardFields({ term: '', answer: '' }, fields.length));
  } else if (action === 'remove-card') {
    const fields = document.querySelectorAll('.flashcard-edit-row');
    if (fields.length <= 1) notify('A study set needs at least one card.');
    else {
      button.closest('.flashcard-edit-row').remove();
      document.querySelectorAll('.flashcard-edit-row').forEach((row, index) => { row.querySelector('.card-number').textContent = `CARD ${String(index + 1).padStart(2, '0')}`; });
    }
  } else if (action === 'flip') {
    if (flashcardSession) flashcardSession.flipped = !flashcardSession.flipped;
    render();
  } else if (action === 'card-prev' || action === 'card-next') {
    const set = state.sets.find((item) => item.id === flashcardSession?.setId);
    if (set && action === 'card-next' && flashcardSession.index === flashcardSession.order.length - 1) {
      flashcardSession = null;
      go('flashcards');
      notify('Study session complete. Nice work.');
      return;
    }
    if (flashcardSession) {
      flashcardSession.index = (flashcardSession.index + (action === 'card-next' ? 1 : -1) + flashcardSession.order.length) % flashcardSession.order.length;
      flashcardSession.flipped = false;
    }
    render();
  } else if (action === 'shuffle') {
    if (flashcardSession) {
      flashcardSession.order.sort(() => Math.random() - 0.5);
      flashcardSession.index = 0;
      flashcardSession.flipped = false;
    }
    render();
    notify('Your cards are shuffled.');
  } else if (action === 'new-schedule') scheduleForm();
  else if (action === 'edit-schedule') scheduleForm(id);
  else if (action === 'delete-schedule') {
    if (window.confirm('Remove this study session?')) {
      const result = await apiCall(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!result) return;
      save('schedules', state.schedules.filter((item) => item.id !== id));
      render();
      notify('Study session removed.');
    }
  } else if (action === 'close-modal') document.querySelector('.modal-backdrop')?.remove();
  else if (action === 'dismiss') button.closest('.notification-card').remove();
  else if (action === 'start-quiz') {
    const isPrivate = String(id).startsWith('private-');
    const quizId = isPrivate ? String(id).slice('private-'.length) : id;
    const quiz = await apiCall(`${isPrivate ? '/my-library/quizzes' : '/quizzes'}/${encodeURIComponent(quizId)}`);
    if (!quiz) return;
    if (!quiz.questions.length) {
      notify('This quiz does not have any questions yet.');
      return;
    }
    const timerRequestStartedAt = performance.now();
    const timer = await apiCall(`${isPrivate ? '/my-library/quizzes' : '/quizzes'}/${encodeURIComponent(quizId)}/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!timer) return;
    if (!timer.timer_token || !Number.isFinite(Number(timer.duration_seconds))) {
      notify('StudyNest could not start the quiz timer. Please try again.');
      return;
    }
    quizQuestions = quiz.questions;
    const requestRoundTrip = performance.now() - timerRequestStartedAt;
    const remainingMilliseconds = Math.max(0, Number(timer.duration_seconds) * 1000 - requestRoundTrip / 2);
    quizSession = {
      quizId,
      isPrivate,
      title: quiz.title,
      subject: quiz.subject,
      returnRoute: isPrivate ? 'my-library' : button.dataset.returnRoute || 'quizzes',
      index: 0,
      answers: {},
      timerToken: timer.timer_token,
      deadline: performance.now() + remainingMilliseconds,
      timeExpired: false,
      submitting: false,
    };
    go('active-quiz');
    startQuizCountdown();
  } else if (action === 'answer') {
    if (quizSession?.timeExpired || quizSession?.submitting) return;
    if (quizSession) quizSession.answers[quizSession.index] = Number(button.dataset.index);
    render();
  } else if (action === 'question-next') {
    if (quizSession?.timeExpired || quizSession?.submitting) return;
    if (quizSession) quizSession.index = Math.min(quizSession.index + 1, quizQuestions.length - 1);
    render();
  } else if (action === 'question-prev') {
    if (quizSession?.timeExpired || quizSession?.submitting) return;
    if (quizSession) quizSession.index = Math.max(quizSession.index - 1, 0);
    render();
  } else if (action === 'jump-question') {
    if (quizSession?.timeExpired || quizSession?.submitting) return;
    if (quizSession) quizSession.index = Number(button.dataset.index);
    render();
  } else if (action === 'exit-quiz') {
    const returnRoute = quizSession?.returnRoute || (quizSession?.isPrivate ? 'my-library' : 'quizzes');
    stopQuizCountdown();
    quizSession = null;
    go(returnRoute);
  } else if (action === 'submit-quiz') await submitActiveQuiz();
  } finally {
    finishLoading();
  }
});

app.addEventListener('load', (event) => {
  const frame = event.target;
  if (!(frame instanceof HTMLIFrameElement) || !frame.matches('.lesson-pdf-viewer')) return;
  markPdfLessonAsRead(Number(frame.dataset.id));
}, true);

window.addEventListener('hashchange', () => {
  const nextLessonId = Number(route().match(/(?:^|\/)lesson\/(\d+)/)?.[1]) || null;
  if (lessonSpeech.status !== 'idle' && lessonSpeech.lessonId !== nextLessonId) stopLessonSpeech();
  if (route() !== 'active-quiz') stopQuizCountdown();
  document.querySelector('.modal-backdrop')?.remove();
  render();
  if (route() === 'active-quiz') updateQuizCountdown();
  if (route() === 'notifications' && state.user) {
    refreshStoredNotifications().then((loaded) => {
      if (loaded && route() === 'notifications') render();
    });
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateQuizCountdown();
});

render();
if (['login', 'register', 'verify-email', 'forgot-password', 'reset-password', 'google-auth'].includes(route())) {
  restoreInitialSession();
} else {
  loadBackendState();
}