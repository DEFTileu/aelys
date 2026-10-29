export type RoutePath =
  | '/'
  | '/projects'
  | '/notes'
  | '/tasks'
  | '/calendar'
  | '/mail'
  | '/finance'
  | '/timer'
  | '/ai'
  | '/developer'
  | '/automation'
  | '/search'
  | '/settings'

export type ApiStatus = 'loading' | 'ready' | 'empty' | 'error' | 'offline'

export type ApiResourceState<T> = {
  status: ApiStatus
  data: T | null
  error: string | null
}

export type SolarPeriod = 'morning' | 'day' | 'evening' | 'night'
export type WeatherCondition = 'sunny' | 'clear' | 'fog' | 'rain' | 'cloudy' | 'snow' | 'sunset' | 'unknown'

export type WeatherBackground = {
  id: string
  file: string
  solarPeriod: SolarPeriod
  weather: Exclude<WeatherCondition, 'unknown'>
}

export type ApiConfig = {
  baseUrl: string
}
