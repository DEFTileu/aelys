import { CloudSun } from '../../icons'

export function DashboardDemoWeather({ compact }: { compact: boolean }) {
  return <div className={`weather-card-body${compact ? ' weather-card-body--compact' : ''}`} aria-label="Пример погоды">
    <span className="weather-location">Алматы · демо</span>
    <div className="weather-current"><CloudSun size={38} aria-hidden="true" /><strong>18°C</strong></div>
    <div className="weather-description">Переменная облачность · ощущается 16°C</div>
    <div className="weather-forecast">{[['Сегодня', '18° / 9°'], ['Завтра', '16° / 7°'], ['Послезавтра', '15° / 6°']].map(([day, value]) => <div key={day}><small>{day}</small><CloudSun size={17} aria-hidden="true" /><span>{value}</span></div>)}</div>
    <small className="weather-updated">Вымышленный прогноз для просмотра виджета</small>
  </div>
}
