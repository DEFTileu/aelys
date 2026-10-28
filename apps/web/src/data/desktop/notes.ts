import { Archive, BookOpen, Bold, FileText, Folder, GraduationCap, House, Image as ImageIcon, Italic, Leaf, Lightbulb, Link, List, ListOrdered, SquareCheck, Trash2, Underline, type LucideIcon } from 'lucide-react'

export const NOTE_COLORS = { violet: '#6A4CF2', blue: '#2F6FE4', green: '#14966C', orange: '#D97706', red: '#D93636', gray: '#6B6672' } as const
export type NoteColor = keyof typeof NOTE_COLORS

// Ink color plus the 10% tint the design uses for icon chips and tag backgrounds.
export const noteTone = (color: NoteColor) => ({ c: NOTE_COLORS[color], soft: `${NOTE_COLORS[color]}1A` })

export const NOTES_TOOLBAR = { placeholder: 'Search notes or ask Aelys…', primary: 'New note' }

export const NOTE_FOLDERS: { title: string; count: number; icon: LucideIcon; color: string; active: boolean }[] = [
  { title: 'All notes', count: 24, icon: FileText, color: '#5132D6', active: true },
  { title: 'Study', count: 6, icon: GraduationCap, color: '#14966C', active: false },
  { title: 'Projects', count: 8, icon: Folder, color: '#D93636', active: false },
  { title: 'Personal', count: 6, icon: House, color: '#D97706', active: false },
  { title: 'Archive', count: 4, icon: Archive, color: '#4F4A56', active: false },
  { title: 'Trash', count: 0, icon: Trash2, color: '#4F4A56', active: false },
]

export const NOTE_TAGS: { name: string; count: number; color: NoteColor }[] = [
  { name: 'design', count: 6, color: 'violet' },
  { name: 'product', count: 4, color: 'red' },
  { name: 'study', count: 5, color: 'blue' },
  { name: 'ideas', count: 7, color: 'green' },
  { name: 'personal', count: 3, color: 'orange' },
]

export type NoteTag = { name: string; color: NoteColor }
export type NoteItem = { title: string; when: string; summary: string; icon: LucideIcon; color: NoteColor; tags: NoteTag[] }

export const NOTES: NoteItem[] = [
  { title: 'Design ideas', when: '10:24', summary: 'Ideas for the new Aelys interface. Inspiration, references and principles.', icon: Lightbulb, color: 'orange', tags: [{ name: 'design', color: 'violet' }, { name: 'product', color: 'red' }] },
  { title: 'Release plan', when: 'Yesterday', summary: 'Milestones, tasks and key dates for v1.0, and who owns what.', icon: FileText, color: 'blue', tags: [{ name: 'product', color: 'red' }, { name: 'plan', color: 'gray' }] },
  { title: 'Lecture notes', when: 'Oct 26', summary: 'Product design basics: user scenarios, metrics and case studies.', icon: GraduationCap, color: 'green', tags: [{ name: 'study', color: 'blue' }, { name: 'lecture', color: 'gray' }] },
  { title: 'Personal plan', when: 'Oct 24', summary: 'Goals for the month: skills, sport and work-life balance.', icon: Leaf, color: 'green', tags: [{ name: 'personal', color: 'orange' }, { name: 'plan', color: 'gray' }] },
  { title: 'Book notes', when: 'Oct 21', summary: 'Ideas from books I want to apply at work and in life.', icon: BookOpen, color: 'violet', tags: [{ name: 'books', color: 'green' }, { name: 'growth', color: 'gray' }] },
]

export type EditorTool = { title: string; label?: string; icon?: LucideIcon } | 'separator'
export const EDITOR_TOOLS: EditorTool[] = [
  { title: 'H1', label: 'H1' },
  { title: 'H2', label: 'H2' },
  { title: 'H3', label: 'H3' },
  'separator',
  { title: 'Bold', icon: Bold },
  { title: 'Italic', icon: Italic },
  { title: 'Underline', icon: Underline },
  'separator',
  { title: 'Bulleted list', icon: List },
  { title: 'Numbered list', icon: ListOrdered },
  { title: 'Checklist', icon: SquareCheck },
  'separator',
  { title: 'Link', icon: Link },
  { title: 'Image', icon: ImageIcon },
]

export const NOTE_DOC = {
  title: 'Design ideas',
  folder: 'Projects',
  updated: 'October 28, 10:24',
  tags: ['design', 'product'],
  goal: 'Collect ideas and principles to improve the Aelys interface while keeping a sense of calm, simplicity and productivity.',
  inspiration: [
    'Mountain landscapes as a source of visual style and atmosphere',
    'Soft glass panels and pastel colors',
    'Minimalism and focus on what matters',
    'A unified system of icons and illustrations',
    'A sense of space and air in the interface',
  ],
}

export const KEY_IDEAS = [
  'Use the mountain photo as a constant accent',
  'Add more micro-interactions',
  'Make core actions quick to reach',
  'Improve readability and hierarchy',
  'Design a dark theme',
  'Add personalization: avatar, greeting, goals',
]

// The design's references use assets/wallpaper.png, which is not in the app; a weather photo stands in until that asset exists.
export const REFERENCE_IMAGE = '/backgrounds/weather/08_evening_sunset.jpg'
export const REFERENCE_POSITIONS = ['85% 35%', '45% 50%', '8% 55%']
