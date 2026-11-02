"""Pure evidence admission; no device, network, fixture mutation or app-private API."""
from math import isfinite
import json
from driver import CheckFailed, exactly_one, label, node_bounds, outer_webview

STATE_FIELDS = ('counter', 'draft', 'mirror', 'selected', 'edge', 'scroll')

def positive_area(node):
    try:node_bounds(node);return True
    except CheckFailed:return False

def visible_webview(nodes):
    return exactly_one(nodes,lambda node:node.get('class')=='android.webkit.WebView' and node.get('_webview-depth')==0 and positive_area(node),'one positive-area outer native WebView')

def identity(row):
    return tuple(row[key] for key in ('id', 'generation', 'frameId', 'contextUniqueId'))

def target_map(rows):
    result = {}
    generations = set()
    for row in rows:
        if row.get('id') in result or row.get('generation') in generations:
            raise CheckFailed('Duplicate target/generation cannot establish session identity')
        if any(not isinstance(row.get(key), str) or not row[key] for key in ('id', 'generation', 'frameId', 'contextUniqueId')):
            raise CheckFailed('Incomplete target identity')
        result[row['id']] = row
        generations.add(row['generation'])
    return result

def same_instances(before, after):
    a, b = target_map(before), target_map(after)
    if set(a) != set(b) or any(identity(a[key]) != identity(b[key]) for key in a):
        raise CheckFailed('Loaded target, native generation, frame or execution context was replaced')

def assert_state(expected, actual, tolerance=1):
    for field in STATE_FIELDS:
        if field == 'scroll':
            if any(abs(expected[field][axis] - actual[field][axis]) > tolerance for axis in ('x', 'y', 'rail')):
                raise CheckFailed('Actual napplet scroll position was not retained')
        elif expected[field] != actual[field]:
            raise CheckFailed('Actual napplet state changed: ' + field)

def correlate_counter(before, after):
    same_instances(before, after)
    a, b = target_map(before), target_map(after)
    changed = []
    for key, row in a.items():
        old, new = row['snapshot'], b[key]['snapshot']
        if not str(old['counter']).isdigit() or not str(new['counter']).isdigit():
            raise CheckFailed('Non-numeric counter cannot identify a target')
        delta = int(new['counter']) - int(old['counter'])
        if delta == 1:
            changed.append(key)
            if any(old[field] != new[field] for field in ('draft', 'mirror', 'selected', 'edge')):
                raise CheckFailed('Counter correlation also changed unrelated fixture data')
        elif delta != 0:
            raise CheckFailed('Counter correlation was not exactly one native increment')
        elif any(old[field] != new[field] for field in STATE_FIELDS):
            raise CheckFailed('An inactive fixture changed during counter correlation')
    if len(changed) != 1:
        raise CheckFailed('Native tap did not identify exactly one changed existing target')
    return b[changed[0]]

def visible_control(snapshot, name):
    box = snapshot['controls'].get(name)
    if not box or any(not isinstance(box.get(key), (float, int)) or not isfinite(box[key]) for key in ('x', 'y', 'width', 'height')):
        raise CheckFailed('Actual child control rectangle missing: ' + name)
    viewport = snapshot['viewport']
    if box['width'] <= 0 or box['height'] <= 0 or box['x'] < 0 or box['y'] < 0 or box['x'] + box['width'] > viewport['width'] + 1 or box['y'] + box['height'] > viewport['height'] + 1:
        raise CheckFailed('Actual child control is clipped: ' + name)
    return box

def common_increment(rows):
    if not rows:
        raise CheckFailed('No unbound fixture candidate')
    boxes = [visible_control(row['snapshot'], 'increment') for row in rows]
    first = rows[0]['snapshot']
    if any(row['snapshot']['viewport'] != first['viewport'] or box != boxes[0] for row, box in zip(rows, boxes)):
        raise CheckFailed('Candidate rectangles differ: no safe common native tap coordinate')
    return first, boxes[0]

def target_at_native_bounds(rows,bounds):
    """Require Chromium's renderer screen rect to match the observed native view."""
    x1,y1,x2,y2=bounds
    expected=(x1,y1,x2-x1,y2-y1)
    matches=[]
    for row in rows:
        try:description=json.loads(row['description'])
        except (KeyError,TypeError,ValueError) as error:
            raise CheckFailed('Missing or malformed Chromium target geometry') from error
        if description.get('attached') is not True or description.get('empty') is not False or description.get('visible') is not True:
            continue
        values=[description.get(key) for key in ('screenX','screenY','width','height')]
        if any(not isinstance(value,(int,float)) or not isfinite(value) for value in values):
            raise CheckFailed('Non-numeric Chromium target geometry')
        if all(abs(actual-wanted)<=1 for actual,wanted in zip(values,expected)):
            matches.append(row)
    if len(matches)!=1:raise CheckFailed('No unique exact native-view/Chromium-target rectangle match')
    return matches[0]

def native_focus(nodes, require_status=True):
    name = exactly_one(nodes, lambda node: node.get('resource-id', '').split('/')[-1] == 'focused-napplet-name', 'native focused title')
    statuses=[node for node in nodes if node.get('resource-id','').split('/')[-1].startswith('runtime-status-')]
    title = label(name)
    if title not in ('UX Lab 1', 'UX Lab 2', 'UX Lab 3', 'UX Lab 4'):
        raise CheckFailed('Native focused fixture title is ambiguous')
    session = 'ux-lab-' + title.split()[-1]
    visible_statuses = [node for node in statuses if positive_area(node)]
    if require_status or visible_statuses:
        status = exactly_one(visible_statuses, positive_area, 'one positive-area native runtime status')
        if status['resource-id'].split('/')[-1] != 'runtime-status-' + session or label(status) != 'Runtime connected':
            raise CheckFailed('Native title/session/readiness binding is ambiguous')
    # Glass hides the connected-status label. This opt-in identifies only the
    # visible native surface; target inspection and causal input prove readiness.
    return {'title': title, 'sessionId': session, 'webViewBounds': node_bounds(visible_webview(nodes)),
      'nonvisibleStatusesInFullDump':[{'sessionId':node.get('resource-id'),'bounds':node.get('bounds')} for node in statuses if not positive_area(node)]}

def require_two_columns(nodes, titles):
    cards = [exactly_one(nodes, lambda node, title=title: label(node) == 'Open ' + title, 'overview ' + title) for title in titles]
    if len(cards) < 2:
        raise CheckFailed('Two-column proof requires at least two cards')
    a, b = [node_bounds(card) for card in cards[:2]]
    if abs(a[1]-b[1]) > 3 or a[2] >= b[0] or abs((a[2]-a[0])-(b[2]-b[0])) > 3:
        raise CheckFailed('Observed overview does not have two equal-width separated columns')
    if len(cards) >= 3:
        c = node_bounds(cards[2])
        if c[1] <= a[3] or abs(c[0]-a[0]) > 3:
            raise CheckFailed('Third overview card is not the next row in opening order')
    return [node_bounds(card) for card in cards]
