import { useSyncExternalStore } from 'react'

import { unreadStore } from '../lib/notifications.js'

/** The unread count the bell, its panel and `/notifications` share (W13.17). */
export default function useUnread() {
  return useSyncExternalStore(unreadStore.subscribe, unreadStore.get)
}
