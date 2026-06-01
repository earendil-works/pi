import { Clock } from "lucide-react";

export default function CronPage() {
  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-4">
        <Clock className="w-6 h-6" />
        <h1 className="text-2xl font-bold">Cron Jobs</h1>
      </div>
      <p className="text-gray-500">No scheduled tasks yet</p>
    </div>
  );
}
