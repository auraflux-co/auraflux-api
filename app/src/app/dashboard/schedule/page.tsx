import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function SchedulePage() {
  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Schedule</h1>
        <Badge variant="outline">CPD-48 — coming soon</Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Publish schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No scheduled publishes.</p>
        </CardContent>
      </Card>
    </div>
  );
}
