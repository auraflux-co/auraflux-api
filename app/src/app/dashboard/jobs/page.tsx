import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function JobsPage() {
  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <Badge variant="outline">CPD-23 — coming in this sprint</Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job queue</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No jobs yet.</p>
        </CardContent>
      </Card>
    </div>
  );
}
