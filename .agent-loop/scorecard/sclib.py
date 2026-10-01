"""Scorecard data helpers: data.json is the source; build() writes data.js and scorecard.html."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
EPICS = {
    'U': 'U · Correctness', 'V': 'V · Run loop', 'W': 'W · Context and memory',
    'X': 'X · Tools, permissions, hooks', 'Y': 'Y · Sub-agents', 'Z': 'Z · MCP',
    'D': 'D · DX, CLI, packaging', 'P': 'P · UI bindings, channels, schedules',
}


class Card:
    def __init__(self):
        self.d = json.load(open(os.path.join(HERE, 'data.json'), encoding='utf-8'))

    def epic(self, ticket):
        return EPICS[ticket[0]] if ticket[0] in EPICS else EPICS['U']

    def done(self, ticket, pr, title=None, epic=None):
        """Move a ticket from remaining to done (title defaults to its remaining title)."""
        e = epic or self.epic(ticket)
        rows = self.d['remaining'].get(e, [])
        hit = [r for r in rows if r[0] == ticket]
        if hit:
            rows.remove(hit[0])
        t = title or (hit[0][1] if hit else None)
        assert t, 'no title for ' + ticket
        self.d['done'].setdefault(e, []).append([ticket, t, pr])
        self.d['prsMerged'] += 1

    def todo(self, ticket, title, deps='', batch=None):
        self.d['remaining'].setdefault(self.epic(ticket), []).append([ticket, title, deps, batch])

    def batch(self, ticket, n):
        for r in self.d['remaining'][self.epic(ticket)]:
            if r[0] == ticket:
                r[3] = n
                return
        raise AssertionError(ticket)

    def matrix(self, name, status=None, flips=None, flight=None):
        for r in self.d['matrix']:
            if r[0] == name:
                if status:
                    r[1] = status
                if flips is not None:
                    r[4] = flips
                while len(r) > 5:
                    r.pop()
                if flight:
                    r.append('pend')
                return
        raise AssertionError(name)

    def clear_flight(self):
        for r in self.d['matrix']:
            while len(r) > 5:
                r.pop()

    def counts(self):
        c = {'ok': 0, 'warn': 0, 'bad': 0}
        for r in self.d['matrix']:
            c[r[1]] += 1
        return c

    def build(self):
        json.dump(self.d, open(os.path.join(HERE, 'data.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
        js = 'window.SCORECARD = ' + json.dumps(self.d, ensure_ascii=False, indent=1) + ';\n'
        open(os.path.join(HERE, 'data.js'), 'w', encoding='utf-8', newline='\n').write(js)
        parts = [open(os.path.join(HERE, f), encoding='utf-8').read() for f in ('head.html', 'body.html')]
        render = open(os.path.join(HERE, 'render.js'), encoding='utf-8').read()
        html = parts[0] + parts[1] + '<script>\n' + js + '</script>\n<script>\n' + render + '</script>\n'
        open(os.path.join(HERE, 'scorecard.html'), 'w', encoding='utf-8', newline='\n').write(html)
        rem = sum(len(v) for v in self.d['remaining'].values())
        print('scorecard: merged', self.d['prsMerged'], 'remaining', rem, self.counts())
