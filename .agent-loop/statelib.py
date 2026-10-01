"""Small helpers for per-iteration edits of .agent-loop/STATE.md (run from the orchestrator worktree)."""
import re

P = '.agent-loop/STATE.md'


class State:
    def __init__(self):
        self.s = open(P, encoding='utf-8').read()

    def save(self):
        open(P, 'w', encoding='utf-8', newline='\n').write(self.s)

    def rep(self, old, new):
        assert self.s.count(old) >= 1, 'missing: ' + old[:70]
        self.s = self.s.replace(old, new, 1)

    def _row(self, section_start, section_end, first_cell):
        a = self.s.index(section_start)
        b = self.s.index(section_end, a)
        for line in self.s[a:b].split('\n'):
            if line.startswith('| ' + first_cell + ' |'):
                return line
        raise AssertionError('row not found: ' + first_cell)

    def done(self, ticket, pr, note=None):
        """Mark a ticket row merged; optionally append a note to its title."""
        line = self._row('## Ticket tree', '## PR log', ticket)
        cells = line.split(' | ')
        assert '⬜' in line, 'not open: ' + line
        new = line.replace('⬜', '✅ #%d' % pr, 1)
        if note:
            parts = new.split(' | ')
            parts[1] = parts[1] + ' (' + note + ')'
            new = ' | '.join(parts)
        self.rep(line, new)

    def add_ticket(self, after_ticket, row):
        line = self._row('## Ticket tree', '## PR log', after_ticket)
        self.rep(line, line + '\n' + row)

    def matrix(self, row_name, us_cell, flips):
        line = self._row('## Competitor matrix', '## Ticket tree', row_name)
        cells = [c.strip() for c in line.strip('|').split('|')]
        new = '| %s | %s | %s | %s | %s |' % (row_name, us_cell, cells[2], cells[3], flips)
        self.rep(line, new)

    def score(self):
        m = self.s[self.s.index('## Competitor matrix'):self.s.index('## Ticket tree')]
        c = {'✅': 0, '⚠️': 0, '❌': 0}
        for l in m.split('\n'):
            if not l.startswith('| ') or l.startswith('| Row') or l.startswith('|---'):
                continue
            cell = l.split('|')[2].strip()
            for k in c:
                if cell.startswith(k):
                    c[k] += 1
        return c['✅'], c['⚠️'], c['❌']

    def set_score(self, iteration):
        ok, warn, bad = self.score()
        self.s = re.sub(r'Score \(us\): \d+ ✅ / \d+ ⚠️ / \d+ ❌ of 51 after iteration \d+ \(',
                        'Score (us): %d ✅ / %d ⚠️ / %d ❌ of 51 after iteration %d (iteration %d: PREV; ' % (ok, warn, bad, iteration, iteration - 1),
                        self.s, count=1)
        return ok, warn, bad

    def pr_log(self, rows):
        """rows: list of (pr, ticket, note). Appended at the end of the PR log table."""
        a = self.s.index('## Main health')
        block = ''.join('| #%d | %s | merged (squash) | %s |\n' % r for r in rows)
        self.s = self.s[:a].rstrip('\n') + '\n' + block + '\n' + self.s[a:]

    def iteration(self, text):
        a = self.s.index('## Plan to the end')
        self.s = self.s[:a] + text.rstrip('\n') + '\n\n' + self.s[a:]

    def completed(self, n):
        self.s = re.sub(r'Iterations completed: \d+\.', 'Iterations completed: %d.' % n, self.s, count=1)
