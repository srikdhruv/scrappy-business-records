import type { RouteObject } from 'react-router'

import { AppShell } from '@/components/layout/app-shell'
import { DashboardPage } from '@/pages/dashboard-page'
import { NotFoundPage } from '@/pages/not-found-page'
import { PaymentsPage } from '@/pages/payments-page'
import { StudentProfilePage } from '@/pages/student-profile-page'
import { StudentsPage } from '@/pages/students-page'

/** Every client-side route. The backend serves index.html for all non-/api paths. */
export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'payments', element: <PaymentsPage /> },
      { path: 'students', element: <StudentsPage /> },
      { path: 'students/batch/:batchId', element: <StudentsPage /> },
      { path: 'students/:id', element: <StudentProfilePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]
