import { AdminAssistant } from '@/components/admin/AdminAssistant';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <AdminAssistant />
    </>
  );
}
