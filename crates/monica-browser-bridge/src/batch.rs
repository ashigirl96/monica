use crate::protocol::Segment;

pub const DEFAULT_CHAR_LIMIT: usize = 3500;

pub fn split_batches(segments: &[Segment], char_limit: usize) -> Vec<&[Segment]> {
    if segments.is_empty() {
        return vec![];
    }

    let mut batches = Vec::new();
    let mut start = 0;
    let mut batch_chars = 0;

    for (i, seg) in segments.iter().enumerate() {
        let seg_chars = seg.text.chars().count();

        if i > start && batch_chars + seg_chars > char_limit {
            batches.push(&segments[start..i]);
            start = i;
            batch_chars = 0;
        }
        batch_chars += seg_chars;
    }

    if start < segments.len() {
        batches.push(&segments[start..]);
    }

    batches
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(id: u64, text: &str) -> Segment {
        Segment {
            seg: id,
            text: text.to_string(),
        }
    }

    #[test]
    fn empty_input() {
        assert!(split_batches(&[], 100).is_empty());
    }

    #[test]
    fn single_segment_under_limit() {
        let segs = [seg(0, "hello")];
        let batches = split_batches(&segs, 100);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 1);
    }

    #[test]
    fn single_segment_over_limit() {
        let segs = [seg(0, "hello world")];
        let batches = split_batches(&segs, 5);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0][0].seg, 0);
    }

    #[test]
    fn splits_at_boundary() {
        let segs = [seg(0, "aaa"), seg(1, "bbb"), seg(2, "ccc")];
        let batches = split_batches(&segs, 6);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 2);
        assert_eq!(batches[1].len(), 1);
        assert_eq!(batches[1][0].seg, 2);
    }

    #[test]
    fn each_segment_in_own_batch() {
        let segs = [seg(0, "aaaa"), seg(1, "bbbb"), seg(2, "cccc")];
        let batches = split_batches(&segs, 4);
        assert_eq!(batches.len(), 3);
    }

    #[test]
    fn all_fit_in_one() {
        let segs = [seg(0, "a"), seg(1, "b"), seg(2, "c")];
        let batches = split_batches(&segs, 100);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 3);
    }
}
