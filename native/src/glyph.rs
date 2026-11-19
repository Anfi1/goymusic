use std::cell::Cell;
use iced::{mouse, Color, Element, Point, Rectangle, Renderer, Size, Theme};
use iced::widget::canvas::{self, Cache, Frame, Geometry, Path, Stroke};
use crate::Message;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Shape { Play, Pause, Previous, Next, Search, Home, Folder, Volume, Muted, Plus, Cross, Disc }
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Ink { Light, Dark, Dim }
#[derive(Clone, Copy, Eq, PartialEq)]
struct Glyph(Shape, Ink);

pub fn icon(shape: Shape, ink: Ink, size: f32) -> Element<'static, Message> {
    canvas::Canvas::new(Glyph(shape, ink)).width(size).height(size).into()
}

fn path(points: &[(f32,f32)], close: bool) -> Path {
    Path::new(|b| {
        b.move_to(Point::new(points[0].0, points[0].1));
        for &(x,y) in &points[1..] { b.line_to(Point::new(x,y)); }
        if close { b.close(); }
    })
}

impl canvas::Program<Message> for Glyph {
    type State = (Cell<Option<Glyph>>, Cache);
    fn draw(&self, (last,cache): &Self::State, renderer: &Renderer, _: &Theme, bounds: Rectangle, _: mouse::Cursor) -> Vec<Geometry> {
        if last.replace(Some(*self)) != Some(*self) { cache.clear(); }
        vec![cache.draw(renderer, bounds.size(), |f| {
            f.scale(bounds.width / 24.0);
            let c = match self.1 { Ink::Light => Color::from_rgb8(218,218,218), Ink::Dark => Color::from_rgb8(28,28,28), Ink::Dim => Color::from_rgb8(116,116,116) };
            let stroke = Stroke::default().with_width(1.7).with_color(c);
            let line = |f: &mut Frame, points: &[(f32,f32)]| f.stroke(&path(points, false), stroke);
            match self.0 {
                Shape::Play => f.fill(&path(&[(7.,4.),(20.,12.),(7.,20.)], true), c),
                Shape::Pause => { for x in [6.0, 14.0] { f.fill_rectangle(Point::new(x,4.), Size::new(4.,16.),c); } }
                Shape::Previous | Shape::Next => {
                    if self.0 == Shape::Previous { f.translate(iced::Vector::new(24.0,0.0)); f.scale_nonuniform(iced::Vector::new(-1.0,1.0)); }
                    f.fill(&path(&[(4.,5.),(16.,12.),(4.,19.)],true),c);
                    f.fill_rectangle(Point::new(17.,5.),Size::new(2.,14.),c);
                }
                Shape::Search => { f.stroke(&Path::circle(Point::new(10.,10.),6.5),stroke); line(f,&[(15.,15.),(21.,21.)]); }
                Shape::Home => f.stroke(&path(&[(3.,10.),(12.,3.),(21.,10.),(21.,20.),(14.,20.),(14.,14.),(10.,14.),(10.,20.),(3.,20.)],true),stroke),
                Shape::Folder => f.stroke(&path(&[(3.,6.),(10.,6.),(12.,8.),(21.,8.),(21.,19.),(3.,19.)],true),stroke),
                Shape::Volume | Shape::Muted => {
                    f.stroke(&path(&[(3.,10.),(7.,10.),(12.,6.),(12.,18.),(7.,14.),(3.,14.)],true),stroke);
                    if self.0 == Shape::Muted { line(f,&[(16.,10.),(21.,15.)]); line(f,&[(21.,10.),(16.,15.)]); }
                    else { line(f,&[(16.,8.),(18.,12.),(16.,16.)]); line(f,&[(19.,5.),(22.,12.),(19.,19.)]); }
                }
                Shape::Plus => { line(f,&[(5.,12.),(19.,12.)]); line(f,&[(12.,5.),(12.,19.)]); }
                Shape::Cross => { line(f,&[(7.,7.),(17.,17.)]); line(f,&[(7.,17.),(17.,7.)]); }
                Shape::Disc => {
                    let center = Point::new(12.,12.);
                    f.fill(&Path::circle(center,11.8),Color::from_rgb8(20,20,20));
                    for i in 0..15 {
                        let v = if i % 3 == 0 { 63 } else { 47 };
                        f.stroke(&Path::circle(center,4.8 + 0.45*i as f32),Stroke::default().with_width(0.11).with_color(Color::from_rgb8(v,v,v)));
                    }
                    f.fill(&Path::circle(center,3.9),Color::from_rgb8(166,166,158));
                    f.fill(&Path::circle(center,0.56),Color::from_rgb8(32,32,32));
                }
            }
        })]
    }
}
