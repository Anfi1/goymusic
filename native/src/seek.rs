use iced::{mouse, touch, Color, Point, Rectangle, Renderer, Size, Theme};
use iced::widget::{canvas::{self, Action, Event, Frame, Geometry, Path}, image::Handle};
use crate::Message;

pub struct Rail<'a> {
    pub position: f64,
    pub duration: Option<f64>,
    pub interactive: bool,
    pub cat: Option<&'a Handle>,
    pub generation: u64,
}

#[derive(Default)]
pub struct Drag { active: Option<u64> }

impl canvas::Program<Message> for Rail<'_> {
    type State = Drag;

    fn update(&self, state: &mut Drag, event: &Event, bounds: Rectangle, cursor: mouse::Cursor) -> Option<Action<Message>> {
        let duration = self.duration.filter(|_| self.interactive)?;
        let (pressed, moved, released, at) = match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => (true, false, false, cursor.position()),
            Event::Mouse(mouse::Event::CursorMoved { position }) => (false, true, false, Some(*position)),
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => (false, false, true, cursor.position()),
            Event::Touch(touch::Event::FingerPressed { position, .. }) => (true, false, false, Some(*position)),
            Event::Touch(touch::Event::FingerMoved { position, .. }) => (false, true, false, Some(*position)),
            Event::Touch(touch::Event::FingerLifted { position, .. }) => (false, false, true, Some(*position)),
            Event::Touch(touch::Event::FingerLost { .. }) => {
                state.active = None;
                return Some(Action::publish(Message::Preview(None)));
            }
            _ => return None,
        };
        let seconds = at.map(|p| ((p.x - bounds.x) / bounds.width.max(1.0)).clamp(0.0, 1.0) as f64 * duration);
        if pressed && at.is_some_and(|p| bounds.contains(p)) { state.active = Some(self.generation); }
        if state.active != Some(self.generation) { return None; }
        if released {
            state.active = None;
            return Some(Action::publish(seconds.map_or(Message::Preview(None), Message::Seek)).and_capture());
        }
        (pressed || moved).then(|| Action::publish(Message::Preview(seconds)).and_capture())
    }

    fn draw(&self, _: &Drag, renderer: &Renderer, _: &Theme, bounds: Rectangle, cursor: mouse::Cursor) -> Vec<Geometry> {
        let mut f = Frame::new(renderer, bounds.size());
        let y = f.height() * 0.5;
        let ratio = self.duration.filter(|d| *d > 0.0).map_or(0.0, |d| (self.position / d).clamp(0.0, 1.0)) as f32;
        let x = f.width() * ratio;
        f.fill_rectangle(Point::new(0.0, y-2.0), Size::new(f.width(), 4.0), Color::from_rgb8(79,79,79));
        if self.duration.is_some() {
            if let Some(cat) = self.cat {
                let width = f.width().min(34.0);
                let left = (x - width * 0.5).clamp(0.0, (f.width()-width).max(0.0));
                for (i, c) in [(249,85,87),(255,171,71),(255,226,82),(104,206,91),(91,174,249),(162,117,232)].into_iter().enumerate() {
                    f.fill_rectangle(Point::new(0.0, y - 3.0 + i as f32), Size::new(left + 8.0, 1.0), Color::from_rgb8(c.0,c.1,c.2));
                }
                f.draw_image(Rectangle { x: left, y: y-10.5, width, height:21.0 }, cat);
            } else {
                f.fill_rectangle(Point::new(0.0,y-2.0), Size::new(x,4.0), Color::from_rgb8(218,218,218));
                f.fill(&Path::circle(Point::new(x.clamp(5.0, (f.width()-5.0).max(5.0)), y), if cursor.is_over(bounds) { 6.0 } else { 5.0 }), Color::WHITE);
            }
        }
        vec![f.into_geometry()]
    }

    fn mouse_interaction(&self, state: &Drag, bounds: Rectangle, cursor: mouse::Cursor) -> mouse::Interaction {
        if self.interactive && self.duration.is_some() && (state.active == Some(self.generation) || cursor.is_over(bounds)) { mouse::Interaction::Pointer } else { mouse::Interaction::default() }
    }
}
