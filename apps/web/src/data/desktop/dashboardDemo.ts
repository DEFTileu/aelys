import type { HomeData } from '../../views/desktop/homeWidgets'

/** Fictional dashboard examples. Never passed to the API, cache or outbox. */
export function createDashboardDemo(now = new Date()): HomeData {
  const at = (hour: number, minute = 0) => {
    const date = new Date(now)
    date.setHours(hour, minute, 0, 0)
    return date.toISOString()
  }
  const projectIds = ['demo-project-aelys', 'demo-project-course', 'demo-project-reading']
  return {
    tasks: ([
      ['Проверить адаптивность виджетов', 10, 0, 'todo'],
      ['Подготовить заметки к семинару', 11, 30, 'todo'],
      ['Разобрать входящие письма', 13, 0, 'completed'],
      ['Закончить главу книги', 17, 0, 'todo'],
      ['Прогулка и перерыв без экрана', 18, 30, 'todo'],
      ['Спланировать следующую неделю', 20, 0, 'completed'],
    ] as const).map(([title, hour, minute, status], index) => ({ id: `demo-task-${index}`, title, description: 'Пример задачи для просмотра Dashboard', project_id: projectIds[index % 3], parent_task_id: null, status, priority: index % 3, due_at: at(hour, minute), due_timezone: 'Asia/Almaty', rrule: null, version: 1 })),
    events: [
      { title: 'Семинар · проектирование систем', hour: 11, minute: 30, duration: 60 },
      { title: 'Работа над Aelys', hour: 14, minute: 0, duration: 90 },
      { title: 'Тренировка', hour: 18, minute: 30, duration: 60 },
    ].map((event, index) => ({ id: `demo-event-${index}`, title: event.title, description: 'Демонстрационное событие', starts_at: at(event.hour, event.minute), ends_at: at(event.hour, event.minute + event.duration), timezone: 'Asia/Almaty', all_day: false, project_id: projectIds[index], linked_task_id: null, rrule: null, version: 1 })),
    projects: [
      { id: projectIds[0], name: 'Aelys · Personal OS', description: 'Dashboard, локальная работа и личные инструменты', status: 'active', version: 1 },
      { id: projectIds[1], name: 'Учёба · осенний семестр', description: 'Семинары, конспекты и подготовка проекта', status: 'active', version: 1 },
      { id: projectIds[2], name: 'Чтение и идеи', description: 'Книги, полезные мысли и небольшие эксперименты', status: 'active', version: 1 },
    ],
    notes: [
      { title: 'Идеи для домашнего экрана', body: 'Оставить главное на виду: задачи, ближайшие события и время для фокуса.' },
      { title: 'Конспект: архитектура приложений', body: 'Локальное хранение, синхронизация и явные границы модулей.' },
      { title: 'План на неделю', body: 'Закончить учебный проект, разобрать заметки и освободить вечер пятницы.' },
      { title: 'Список книг', body: 'Дизайн привычных вещей · Глубокая работа · Чистая архитектура.' },
    ].map((note, index) => ({ id: `demo-note-${index}`, title: note.title, markdown_body: note.body, parent_id: null, project_id: projectIds[index % 3], version: 1 })),
    finance: [
      { amount: '180000.0000', notes: 'Доход · учебный проект', type: 'income', hour: 9 },
      { amount: '-2450.0000', notes: 'Кофе и завтрак', type: 'expense', hour: 10 },
      { amount: '-8900.0000', notes: 'Книга', type: 'expense', hour: 12 },
      { amount: '-7200.0000', notes: 'Продукты', type: 'expense', hour: 16 },
    ].map(({ hour, ...item }, index) => ({ ...item, id: `demo-transaction-${index}`, account_id: 'demo-account', category_id: null, currency: 'KZT', occurred_at: at(hour), idempotency_key: null, owner_id: 'demo-owner', version: 1, related_transfer_id: null })),
    mail: [
      { sender: 'Университет <study@example.test>', subject: 'Материалы к следующему семинару' },
      { sender: 'Команда проекта <team@example.test>', subject: 'План встречи и список задач' },
      { sender: 'Книжный клуб <books@example.test>', subject: 'Что читаем в ноябре' },
    ].map((item, index) => ({ ...item, id: `demo-mail-${index}`, account_id: null, thread_id: null, recipients: ['demo@example.test'], body: 'Это вымышленное письмо для демонстрации интерфейса.', received_at: at(9 + index, 15), sync_origin: 'demo', owner_id: 'demo-owner' })),
    activity: ['Задача выполнена', 'Заметка обновлена', 'Проект создан', 'Фокус-сессия завершена'].map((event_kind, index) => ({ id: `demo-activity-${index}`, owner_id: 'demo-owner', resource_id: null, event_kind, actor_kind: 'Демо', actor_id: null, occurred_at: at(12 - index, 10), non_sensitive_metadata: {} })),
    states: { today: 'ready', cal: 'ready', focus: 'ready', proj: 'ready', notes: 'ready', kb: 'ready', fin: 'ready', mail: 'ready', activity: 'ready' },
  }
}
